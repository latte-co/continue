//! Explicit quit residual resources: finish local closes, reattach remote sessions.
//! No passwords, prompts or Provider secrets.
use crate::{Connections, Host};
use latte_work_client::Client;
use latte_work_protocol::lifecycle::Resource;
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
use tauri::Manager;

#[derive(Serialize, Deserialize)]
struct Intent {
    owner_id: String,
    hosts: Vec<HostIntent>,
}
#[derive(Serialize, Deserialize)]
struct HostIntent {
    host: Host,
    server_id: String,
    resources: Vec<Resource>,
    /// A prior recovery may have adopted this batch before a later batch failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    adopted_owner_id: Option<String>,
    /// Write-ahead record for one bounded batch. Replay this exact transfer to
    /// reconcile either possible owner before attempting a different target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_adoption: Option<Adoption>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Adoption {
    previous_owner_id: String,
    owner_id: String,
}
const LIMIT: u64 = 1024 * 1024;
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("pending-resources"))
}
fn lock(directory: &Path) -> Result<File, String> {
    if directory
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("关闭记录目录不能是符号链接".into());
    }
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let path = directory.join("pending.lock");
    regular(&path)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.try_lock()
        .map_err(|_| "关闭记录正在处理，请稍后重新连接".to_string())?;
    Ok(file)
}
fn regular(path: &Path) -> Result<(), String> {
    match path.symlink_metadata() {
        Ok(m) if m.is_file() => Ok(()),
        Ok(_) => Err("关闭记录必须为普通文件".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
fn write(directory: &Path, intent: &Intent) -> Result<(), String> {
    let owner = uuid::Uuid::parse_str(&intent.owner_id).map_err(|e| e.to_string())?;
    let path = directory.join(format!("{owner}.json"));
    regular(&path)?;
    if intent.hosts.is_empty() {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.to_string()),
        }
    }
    let data = serde_json::to_vec(intent).map_err(|e| e.to_string())?;
    if data.len() as u64 > LIMIT {
        return Err("关闭记录超过大小限制".into());
    }
    let temp = directory.join(format!("{owner}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(&data)?;
        file.sync_all()?;
        std::fs::rename(&temp, &path)?;
        File::open(directory)?.sync_all()
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result.map_err(|e| e.to_string())
}
fn read(path: &Path) -> Result<Intent, String> {
    regular(path)?;
    let mut data = Vec::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(LIMIT + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > LIMIT {
        return Err("关闭记录超过大小限制".into());
    }
    let intent: Intent = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    let owner = uuid::Uuid::parse_str(&intent.owner_id).map_err(|e| e.to_string())?;
    if path.file_name().and_then(|s| s.to_str()) != Some(format!("{owner}.json").as_str())
        || intent.hosts.len() > 4096
        || intent.hosts.iter().any(|h| {
            h.resources
                .iter()
                .any(|r| r.id().is_empty() || r.id().len() > 256)
                || h.pending_adoption.as_ref().is_some_and(|pending| {
                    h.resources.len() > latte_work_protocol::lifecycle::RESOURCE_BATCH_LIMIT
                        || [&pending.previous_owner_id, &pending.owner_id]
                            .iter()
                            .any(|id| id.is_empty() || id.len() > 128)
                })
        })
    {
        return Err("无效关闭记录".into());
    }
    Ok(intent)
}
fn same_target(a: &Host, b: &Host) -> bool {
    a.id == b.id
        && a.ssh == b.ssh
        && a.port == b.port
        && a.server_path == b.server_path
        && a.identity_file == b.identity_file
        && a.auth == b.auth
}
pub(crate) async fn persist(app: &tauri::AppHandle, state: &Connections) -> Result<(), String> {
    let instances = state.owned_instances.lock().await.clone();
    let hosts = state.host_targets.lock().await;
    let mut grouped = std::collections::BTreeMap::<(String, String), Vec<Resource>>::new();
    for ((host, resource), server_id) in instances {
        grouped.entry((host, server_id)).or_default().push(resource);
    }
    let mut intents = Vec::new();
    for ((host, server_id), resources) in grouped {
        let host = hosts.get(&host).cloned().ok_or("缺少关闭记录的主机信息")?;
        intents.push(HostIntent {
            host,
            server_id,
            resources,
            adopted_owner_id: None,
            pending_adoption: None,
        });
    }
    let intent = Intent {
        owner_id: state.owner_id().to_owned(),
        hosts: intents,
    };
    let directory = directory(app)?;
    let _lock = lock(&directory)?;
    write(&directory, &intent)
}
/// Resolve local cleanup or remote reattachment before exposing a connection.
pub(crate) async fn drain(
    app: &tauri::AppHandle,
    state: &Connections,
    host: &Host,
    client: &mut Client,
) -> Result<Vec<Resource>, String> {
    let _admission = state.cleanup_admission.lock().await;
    let adopted = drain_directory(&directory(app)?, host, client, state.owner_id()).await?;
    for resource in &adopted {
        state.owned_instances.lock().await.insert(
            (host.id.clone(), resource.clone()),
            client.server_id().to_owned(),
        );
        match resource {
            Resource::AgentSession(id) => {
                state
                    .turns
                    .lock()
                    .await
                    .insert((host.id.clone(), id.clone()), "open".into());
            }
            Resource::Terminal(id) => {
                state
                    .terminals
                    .lock()
                    .await
                    .insert((host.id.clone(), id.clone()));
            }
        }
    }
    Ok(adopted)
}
async fn drain_directory(
    directory: &Path,
    host: &Host,
    client: &mut Client,
    owner_id: &str,
) -> Result<Vec<Resource>, String> {
    drain_directory_with_cleanup(directory, host, client, owner_id, write).await
}
async fn drain_directory_with_cleanup(
    directory: &Path,
    host: &Host,
    client: &mut Client,
    owner_id: &str,
    mut cleanup: impl FnMut(&Path, &Intent) -> Result<(), String>,
) -> Result<Vec<Resource>, String> {
    let _lock = lock(directory)?;
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|e| e == "json") {
            if paths.len() >= 128 {
                return Err("待关闭记录数量超过限制".into());
            }
            paths.push(path);
        }
    }
    paths.sort();
    let mut adopted = Vec::new();
    for path in &paths {
        let mut intent = read(path)?;
        let mut index = 0;
        while index < intent.hosts.len() {
            if !same_target(&intent.hosts[index].host, host) {
                index += 1;
                continue;
            }
            let item = &intent.hosts[index];
            let batch = item
                .resources
                .iter()
                .take(latte_work_protocol::lifecycle::RESOURCE_BATCH_LIMIT)
                .cloned()
                .collect::<Vec<_>>();
            if host.ssh.is_some() {
                // Split before journaling: an uncertain transfer must identify
                // exactly the resource batch sent, not the untouched remainder.
                if intent.hosts[index].resources.len() > batch.len() {
                    let remaining = intent.hosts[index].resources.split_off(batch.len());
                    let item = &intent.hosts[index];
                    let remainder = HostIntent {
                        host: item.host.clone(),
                        server_id: item.server_id.clone(),
                        resources: remaining,
                        adopted_owner_id: item.adopted_owner_id.clone(),
                        pending_adoption: None,
                    };
                    intent.hosts.insert(index + 1, remainder);
                }
                adopt_batch(directory, &mut intent, index, client, owner_id).await?;
                adopted.extend(intent.hosts[index].resources.clone());
                if intent.hosts[index].resources.is_empty() {
                    intent.hosts.remove(index);
                } else {
                    index += 1;
                }
            } else {
                client
                    .close_owned_resources(
                        item.server_id.clone(),
                        intent.owner_id.clone(),
                        batch.clone(),
                    )
                    .await
                    .map_err(|e| format!("{e:#}"))?;
                intent.hosts[index].resources.drain(..batch.len());
                if intent.hosts[index].resources.is_empty() {
                    intent.hosts.remove(index);
                }
            }
            write(directory, &intent)?;
        }
    }
    let mut seen = std::collections::HashSet::new();
    adopted.retain(|resource| seen.insert(resource.clone()));
    // Durable handoff precedes any old-record deletion. Keep it after returning:
    // a crash can occur before the caller registers resources in App memory too.
    // The next recovery consolidates this record along with any remaining old
    // records; closed or foreign-owned resources simply do not get re-adopted.
    if host.ssh.is_some() && !adopted.is_empty() {
        write(
            directory,
            &Intent {
                owner_id: uuid::Uuid::new_v4().to_string(),
                hosts: vec![HostIntent {
                    host: host.clone(),
                    server_id: client.server_id().to_owned(),
                    resources: adopted.clone(),
                    adopted_owner_id: Some(owner_id.to_owned()),
                    pending_adoption: None,
                }],
            },
        )?;
    }
    for path in &paths {
        if !path.exists() {
            continue;
        }
        let mut intent = read(path)?;
        intent.hosts.retain(|h| !same_target(&h.host, host));
        cleanup(directory, &intent)?;
    }
    Ok(adopted)
}

async fn adopt_batch(
    directory: &Path,
    intent: &mut Intent,
    index: usize,
    client: &mut Client,
    owner_id: &str,
) -> Result<(), String> {
    // Reconcile the previous A -> B request as A -> B, even in App C. The
    // Server accepts both A and B, while unrelated owners and daemon IDs remain
    // fenced. Repeated response loss keeps the same two candidates on disk.
    if intent.hosts[index].pending_adoption.is_some() {
        finish_adoption(directory, intent, index, client).await?;
        if intent.hosts[index].resources.is_empty()
            || intent.hosts[index].adopted_owner_id.as_deref() == Some(owner_id)
        {
            return Ok(());
        }
    }
    let item = &mut intent.hosts[index];
    item.pending_adoption = Some(Adoption {
        previous_owner_id: item
            .adopted_owner_id
            .clone()
            .unwrap_or_else(|| intent.owner_id.clone()),
        owner_id: owner_id.to_owned(),
    });
    // A failed fsync/rename must prevent the ownership-changing RPC entirely.
    write(directory, intent)?;
    finish_adoption(directory, intent, index, client).await
}

async fn finish_adoption(
    directory: &Path,
    intent: &mut Intent,
    index: usize,
    client: &mut Client,
) -> Result<(), String> {
    let item = &intent.hosts[index];
    let pending = item
        .pending_adoption
        .as_ref()
        .expect("journaled adoption")
        .clone();
    let resources = client
        .adopt_resources(
            item.server_id.clone(),
            pending.previous_owner_id,
            pending.owner_id.clone(),
            item.resources.clone(),
        )
        .await
        .map_err(|e| format!("{e:#}"))?;
    let item = &mut intent.hosts[index];
    item.resources = resources;
    item.adopted_owner_id = Some(pending.owner_id);
    item.pending_adoption = None;
    write(directory, intent)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn host() -> Host {
        serde_json::from_value(serde_json::json!({"id":"local", "name":"本机", "ssh":null}))
            .unwrap()
    }
    #[test]
    fn quit_intent_is_private_atomic_and_contains_no_authentication_secret() {
        let directory = std::env::temp_dir().join(format!("lw-pending-{}", uuid::Uuid::new_v4()));
        let _lock = lock(&directory).unwrap();
        let intent = Intent {
            owner_id: uuid::Uuid::new_v4().to_string(),
            hosts: vec![HostIntent {
                host: host(),
                server_id: "old-server".into(),
                resources: vec![Resource::AgentSession("session".into())],
                adopted_owner_id: None,
                pending_adoption: None,
            }],
        };
        write(&directory, &intent).unwrap();
        let path = directory.join(format!("{}.json", intent.owner_id));
        assert_eq!(read(&path).unwrap().hosts[0].server_id, "old-server");
        assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(
            directory.metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(!std::fs::read_to_string(&path).unwrap().contains("password"));
        let mut different = host();
        different.ssh = Some("other-target".into());
        assert!(!same_target(&host(), &different));
        drop(_lock);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn journal_rejects_symlinks_and_mismatched_owner_file() {
        let directory = std::env::temp_dir().join(format!("lw-pending-{}", uuid::Uuid::new_v4()));
        let _lock = lock(&directory).unwrap();
        let outside = directory.join("outside");
        std::fs::write(&outside, "private").unwrap();
        let path = directory.join("alias.json");
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(read(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::write(
            &path,
            serde_json::to_vec(&Intent {
                owner_id: uuid::Uuid::new_v4().to_string(),
                hosts: vec![],
            })
            .unwrap(),
        )
        .unwrap();
        assert!(read(&path).is_err());
        drop(_lock);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    async fn reconnect_closes_local_resources_but_only_adopts_remote_resources() {
        use std::os::unix::fs::PermissionsExt;
        for remote in [false, true] {
            let directory =
                std::env::temp_dir().join(format!("lw-pending-{}", uuid::Uuid::new_v4()));
            let _lock = lock(&directory).unwrap();
            let binary = directory.join("bridge");
            std::fs::write(&binary, r#"#!/usr/bin/env python3
import sys,json,pathlib
base=pathlib.Path(sys.argv[sys.argv.index('--state-dir')+1])
for line in sys.stdin:
    request=json.loads(line)
    with (base/'requests').open('a') as f: f.write(request['method']+'\n')
    if request['method']=='hello': response={'kind':'hello','version':1,'server_id':'fixture','agents':[]}
    elif request['method']=='adopt_resources':
        assert len(request['resources'])<=128
        response={'kind':'resources_adopted','resources':request['resources']}
    elif request['method']=='close_owned_resources':
        assert len(request['resources'])<=128
        response={'kind':'resources_closed'}
    else: response={'kind':'error','code':'unexpected','message':'No Open or Send allowed'}
    print(json.dumps(response),flush=True)
"#).unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            let mut host = host();
            if remote {
                host.id = "remote".into();
                host.ssh = Some("devbox".into());
            }
            let owner = uuid::Uuid::new_v4().to_string();
            let resources: Vec<_> = (0..129)
                .map(|n| Resource::AgentSession(format!("session-{n}")))
                .collect();
            write(
                &directory,
                &Intent {
                    owner_id: owner.clone(),
                    hosts: vec![HostIntent {
                        host: host.clone(),
                        server_id: "fixture".into(),
                        resources: resources.clone(),
                        adopted_owner_id: None,
                        pending_adoption: None,
                    }],
                },
            )
            .unwrap();
            drop(_lock);
            let mut client = Client::local(&binary, Some(&directory)).await.unwrap();
            let adopted = drain_directory(&directory, &host, &mut client, "new-app")
                .await
                .unwrap();
            assert_eq!(adopted, if remote { resources } else { vec![] });
            assert!(!directory.join(format!("{owner}.json")).exists());
            assert_eq!(
                std::fs::read_to_string(directory.join("requests")).unwrap(),
                if remote {
                    "hello\nadopt_resources\nadopt_resources\n"
                } else {
                    "hello\nclose_owned_resources\nclose_owned_resources\n"
                }
            );
            drop(client);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
    #[tokio::test]
    async fn partial_remote_adoption_retains_acknowledged_owner_for_retry() {
        let directory =
            std::env::temp_dir().join(format!("lw-pending-batches-{}", uuid::Uuid::new_v4()));
        let guard = lock(&directory).unwrap();
        let binary = directory.join("bridge");
        std::fs::write(
            &binary,
            r#"#!/usr/bin/env python3
import sys,json,pathlib
base=pathlib.Path(sys.argv[sys.argv.index('--state-dir')+1])
for line in sys.stdin:
    r=json.loads(line)
    if r['method']=='hello': out={'kind':'hello','version':1,'server_id':'fixture','agents':[]}
    elif r['method']=='adopt_resources':
        assert 0<len(r['resources'])<=128
        with (base/'owners').open('a') as f: f.write(r['previous_owner_id']+'\n')
        if len(r['resources'])==1 and not (base/'failed').exists():
            (base/'failed').touch()
            out={'kind':'error','code':'held','message':'second batch failed'}
        else: out={'kind':'resources_adopted','resources':r['resources']}
    else: raise AssertionError(r)
    print(json.dumps(out),flush=True)
"#,
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut host = host();
        host.ssh = Some("ssh".into());
        let owner = uuid::Uuid::new_v4().to_string();
        let resources: Vec<_> = (0..129)
            .map(|n| Resource::AgentSession(format!("session-{n}")))
            .collect();
        write(
            &directory,
            &Intent {
                owner_id: owner.clone(),
                hosts: vec![HostIntent {
                    host: host.clone(),
                    server_id: "fixture".into(),
                    resources: resources.clone(),
                    adopted_owner_id: None,
                    pending_adoption: None,
                }],
            },
        )
        .unwrap();
        drop(guard);
        let mut client = Client::local(&binary, Some(&directory)).await.unwrap();
        assert!(
            drain_directory(&directory, &host, &mut client, "first-recovery")
                .await
                .is_err()
        );
        let saved = read(&directory.join(format!("{owner}.json"))).unwrap();
        assert_eq!(saved.hosts.len(), 2);
        assert_eq!(
            saved.hosts[0].adopted_owner_id.as_deref(),
            Some("first-recovery")
        );
        assert_eq!(saved.hosts[0].resources.len(), 128);
        assert_eq!(saved.hosts[1].resources.len(), 1);
        let adopted = drain_directory(&directory, &host, &mut client, "second-recovery")
            .await
            .unwrap();
        assert_eq!(adopted, resources);
        assert_eq!(
            std::fs::read_to_string(directory.join("owners")).unwrap(),
            format!("{owner}\n{owner}\nfirst-recovery\n{owner}\nfirst-recovery\n")
        );
        assert!(!directory.join(format!("{owner}.json")).exists());
        drop(client);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn lost_adoption_replies_reconcile_both_owners_across_repeated_app_restarts() {
        for transferred in [false, true] {
            let directory =
                std::env::temp_dir().join(format!("lw-adoption-loss-{}", uuid::Uuid::new_v4()));
            let guard = lock(&directory).unwrap();
            let owner = uuid::Uuid::new_v4().to_string();
            let path = directory.join(format!("{owner}.json"));
            let mut remote = host();
            remote.ssh = Some("fixture-ssh".into());
            let resources = vec![
                Resource::AgentSession("session".into()),
                Resource::Terminal("terminal".into()),
                Resource::AgentSession("foreign".into()),
            ];
            write(
                &directory,
                &Intent {
                    owner_id: owner.clone(),
                    hosts: vec![HostIntent {
                        host: remote.clone(),
                        server_id: "fixture".into(),
                        resources: resources.clone(),
                        adopted_owner_id: None,
                        pending_adoption: None,
                    }],
                },
            )
            .unwrap();
            std::fs::write(
                directory.join("owners.state"),
                serde_json::to_vec(&serde_json::json!({
                    "session":owner, "terminal":owner, "foreign":"unrelated-app"
                }))
                .unwrap(),
            )
            .unwrap();
            if transferred {
                std::fs::write(directory.join("transfer-before-loss"), "").unwrap();
            }
            let binary = directory.join("bridge");
            std::fs::write(&binary, r#"#!/usr/bin/env python3
import sys,json,pathlib
base=pathlib.Path(sys.argv[sys.argv.index('--state-dir')+1])
for line in sys.stdin:
    r=json.loads(line)
    if r['method']=='hello':
        out={'kind':'hello','version':1,'server_id':'fixture','agents':[]}
    elif r['method']=='adopt_resources':
        assert len(r['resources'])<=128
        journal=next(base.glob('*.json'))
        saved=json.loads(journal.read_text())
        assert any(h.get('pending_adoption')=={'previous_owner_id':r['previous_owner_id'],'owner_id':r['owner_id']} and h['resources']==r['resources'] for h in saved['hosts']), 'transfer sent before write-ahead journal'
        owners=json.loads((base/'owners.state').read_text())
        marker=base/('lost-'+r['owner_id'])
        lose=r['owner_id'] in ('app-b','app-c') and not marker.exists()
        selected=[]
        if not lose or (base/'transfer-before-loss').exists():
            for resource in r['resources']:
                if r['server_id']=='fixture' and owners.get(resource['id']) in (r['previous_owner_id'],r['owner_id']):
                    owners[resource['id']]=r['owner_id']
                    selected.append(resource)
            (base/'owners.state').write_text(json.dumps(owners))
        if lose:
            marker.touch()
            sys.exit(0)
        out={'kind':'resources_adopted','resources':selected}
    elif r['method']=='close_owned_resources':
        owners=json.loads((base/'owners.state').read_text())
        for resource in r['resources']:
            if owners.get(resource['id'])==r['owner_id']: del owners[resource['id']]
        (base/'owners.state').write_text(json.dumps(owners))
        out={'kind':'resources_closed'}
    else: raise AssertionError('recovery must not Open or Send: '+str(r))
    print(json.dumps(out),flush=True)
"#).unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            drop(guard);
            for target in ["app-b", "app-c"] {
                let mut client = Client::local(&binary, Some(&directory)).await.unwrap();
                assert!(
                    drain_directory(&directory, &remote, &mut client, target)
                        .await
                        .is_err()
                );
                let saved = read(&path).unwrap();
                assert_eq!(
                    saved.hosts[0].pending_adoption.as_ref().unwrap().owner_id,
                    target
                );
                assert!(!saved.hosts[0].resources.is_empty());
                drop(client);
            }
            let mut client = Client::local(&binary, Some(&directory)).await.unwrap();
            let adopted = drain_directory(&directory, &remote, &mut client, "app-d")
                .await
                .unwrap();
            assert_eq!(adopted, resources[..2]);
            assert!(!path.exists());
            client
                .close_owned_resources("fixture".into(), "app-d".into(), adopted)
                .await
                .unwrap();
            let owners: serde_json::Value =
                serde_json::from_slice(&std::fs::read(directory.join("owners.state")).unwrap())
                    .unwrap();
            assert_eq!(owners, serde_json::json!({"foreign":"unrelated-app"}));
            drop(client);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[tokio::test]
    async fn second_record_cleanup_failure_keeps_first_resources_in_durable_handoff() {
        let directory = std::env::temp_dir().join(format!("lw-handoff-{}", uuid::Uuid::new_v4()));
        let guard = lock(&directory).unwrap();
        let mut remote = host();
        remote.ssh = Some("fixture".into());
        let mut owners = serde_json::Map::new();
        for n in 0..2 {
            let owner = uuid::Uuid::new_v4().to_string();
            let id = format!("session-{n}");
            owners.insert(id.clone(), serde_json::Value::String(owner.clone()));
            write(
                &directory,
                &Intent {
                    owner_id: owner,
                    hosts: vec![HostIntent {
                        host: remote.clone(),
                        server_id: "fixture".into(),
                        resources: vec![Resource::AgentSession(id)],
                        adopted_owner_id: None,
                        pending_adoption: None,
                    }],
                },
            )
            .unwrap();
        }
        std::fs::write(
            directory.join("owners.state"),
            serde_json::to_vec(&owners).unwrap(),
        )
        .unwrap();
        let binary = directory.join("bridge");
        std::fs::write(
            &binary,
            r#"#!/usr/bin/env python3
import sys,json,pathlib
base=pathlib.Path(sys.argv[sys.argv.index('--state-dir')+1])
for line in sys.stdin:
    r=json.loads(line)
    if r['method']=='hello': out={'kind':'hello','version':1,'server_id':'fixture','agents':[]}
    elif r['method']=='adopt_resources':
        owners=json.loads((base/'owners.state').read_text()); selected=[]
        for resource in r['resources']:
            if owners.get(resource['id']) in (r['previous_owner_id'],r['owner_id']):
                owners[resource['id']]=r['owner_id']; selected.append(resource)
        (base/'owners.state').write_text(json.dumps(owners))
        out={'kind':'resources_adopted','resources':selected}
    else: raise AssertionError(r)
    print(json.dumps(out),flush=True)
"#,
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        drop(guard);
        let mut client = Client::local(&binary, Some(&directory)).await.unwrap();
        let mut cleanups = 0;
        let result = drain_directory_with_cleanup(
            &directory,
            &remote,
            &mut client,
            "app-b",
            |directory, intent| {
                cleanups += 1;
                if cleanups == 2 {
                    return Err("injected second record write failure".into());
                }
                write(directory, intent)
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(cleanups, 2);
        drop(client);
        let mut restarted = Client::local(&binary, Some(&directory)).await.unwrap();
        let mut recovered = drain_directory(&directory, &remote, &mut restarted, "app-c")
            .await
            .unwrap();
        recovered.sort_by(|a, b| a.id().cmp(b.id()));
        assert_eq!(
            recovered,
            vec![
                Resource::AgentSession("session-0".into()),
                Resource::AgentSession("session-1".into())
            ]
        );
        let journals: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|s| s == "json"))
            .collect();
        assert_eq!(journals.len(), 1);
        assert_eq!(
            read(&journals[0]).unwrap().hosts[0]
                .adopted_owner_id
                .as_deref(),
            Some("app-c")
        );
        drop(restarted);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
