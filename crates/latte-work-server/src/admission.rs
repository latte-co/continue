//! Bounded ownership of decoded Send attempts, including timed-out continuations.
use crate::runtime::{Database, db};
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

/// A known terminal rejection of this attempt, with no other currently decoded
/// attempt for the identity and no durable admission. Future requests are not covered.
#[derive(Debug)]
pub(crate) struct SendNotAdmitted(String);
impl std::fmt::Display for SendNotAdmitted {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for SendNotAdmitted {}

// Fixed-sized keys avoid retaining another MAX_FRAME-sized request ID per attempt.
// The guard retains the Database Arc until removing its key, preventing pointer reuse.
type Key = (usize, [u8; 32]);
const MAX_ATTEMPTS: usize = 2048;
struct Registry {
    counts: HashMap<Key, usize>,
    total: usize,
    limit: usize,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            counts: HashMap::new(),
            total: 0,
            limit: MAX_ATTEMPTS,
        }
    }
}
fn registry() -> &'static Arc<Mutex<Registry>> {
    static REGISTRY: OnceLock<Arc<Mutex<Registry>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Arc::new(Mutex::new(Registry::default())))
}
fn key(database: &Database, request_id: &str) -> Key {
    (
        Arc::as_ptr(database) as usize,
        Sha256::digest(request_id.as_bytes()).into(),
    )
}

pub(crate) struct Guard {
    registry: Arc<Mutex<Registry>>,
    database: Database,
    key: Key,
}
impl Guard {
    pub(crate) fn reserve(database: &Database, request_id: &str) -> Result<Self> {
        Self::reserve_in(registry().clone(), database, request_id)
    }
    fn reserve_in(
        registry: Arc<Mutex<Registry>>,
        database: &Database,
        request_id: &str,
    ) -> Result<Self> {
        let key = key(database, request_id);
        {
            let mut state = registry
                .lock()
                .map_err(|_| anyhow::anyhow!("消息准入状态锁异常"))?;
            if state.total >= state.limit {
                anyhow::bail!("消息准入核对繁忙，请使用原请求 ID 核对；不会自动重发");
            }
            let total = state.total.checked_add(1).context("消息准入计数超出范围")?;
            let count = state
                .counts
                .get(&key)
                .copied()
                .unwrap_or_default()
                .checked_add(1)
                .context("消息准入计数超出范围")?;
            state.counts.insert(key, count);
            state.total = total;
        }
        Ok(Self {
            registry,
            database: database.clone(),
            key,
        })
    }
    pub(crate) fn matches(&self, database: &Database, request_id: &str) -> bool {
        self.key == key(database, request_id)
    }
    /// Lock order is admission -> database. Do not invoke while holding the DB lock.
    /// The current guard must stay owned until this attempt's terminal rejection.
    pub(crate) fn reject(&self, request_id: &str, message: String) -> anyhow::Error {
        let state = match self.registry.lock() {
            Ok(state) => state,
            Err(_) => return anyhow::anyhow!("消息准入状态锁异常；请使用原请求 ID 核对"),
        };
        if !self.matches(&self.database, request_id) || state.counts.get(&self.key) != Some(&1) {
            return anyhow::Error::msg(message);
        }
        // Keep the same guard-state lock through the single successful SQL snapshot.
        match db(&self.database, |store| {
            store.request_identity_absent(request_id)
        }) {
            Ok(true) => SendNotAdmitted(message).into(),
            Ok(false) => anyhow::Error::msg(message),
            Err(error) => error.context("无法核实消息准入状态，请使用原请求 ID 核对；不会自动重发"),
        }
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        match self.registry.lock() {
            Ok(mut state) => {
                if let Some(count) = state.counts.get(&self.key).copied() {
                    if count == 1 {
                        state.counts.remove(&self.key);
                    } else {
                        state.counts.insert(self.key, count.saturating_sub(1));
                    }
                    state.total = state.total.saturating_sub(1);
                }
            }
            // A poisoned registry fails future reservations/rejections closed.
            Err(_) => eprintln!("消息准入状态锁异常，无法释放核对记录"),
        }
    }
}

#[cfg(test)]
pub(crate) fn active(database: &Database, request_id: &str) -> usize {
    registry()
        .lock()
        .unwrap()
        .counts
        .get(&key(database, request_id))
        .copied()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    #[test]
    fn same_identity_attempts_coexist_until_each_owner_drops() {
        let root = tempfile::tempdir().unwrap();
        let database = Arc::new(Mutex::new(
            Store::open(&root.path().join("state.sqlite")).unwrap(),
        ));
        let registry = Arc::new(Mutex::new(Registry::default()));
        let older = Guard::reserve_in(registry.clone(), &database, "same").unwrap();
        let current = Guard::reserve_in(registry.clone(), &database, "same").unwrap();
        assert!(
            !current
                .reject("same", "terminal".into())
                .is::<SendNotAdmitted>()
        );
        assert!(
            !older
                .reject("same", "terminal".into())
                .is::<SendNotAdmitted>()
        );
        drop(older);
        assert!(
            current
                .reject("same", "terminal".into())
                .is::<SendNotAdmitted>()
        );
        assert!(
            !current
                .reject("different", "terminal".into())
                .is::<SendNotAdmitted>()
        );
        drop(current);
        assert_eq!(registry.lock().unwrap().total, 0);
        assert!(registry.lock().unwrap().counts.is_empty());
    }

    #[test]
    fn capacity_is_bounded_for_attempts_and_keys_do_not_retain_long_ids() {
        let root = tempfile::tempdir().unwrap();
        let database = Arc::new(Mutex::new(
            Store::open(&root.path().join("state.sqlite")).unwrap(),
        ));
        let registry = Arc::new(Mutex::new(Registry {
            limit: 2,
            ..Registry::default()
        }));
        let id = "x".repeat(latte_work_protocol::MAX_FRAME);
        let first = Guard::reserve_in(registry.clone(), &database, &id).unwrap();
        let second = Guard::reserve_in(registry.clone(), &database, &id).unwrap();
        let error = Guard::reserve_in(registry.clone(), &database, "third")
            .err()
            .unwrap();
        assert!(!error.is::<SendNotAdmitted>());
        assert_eq!(registry.lock().unwrap().counts.len(), 1);
        assert_eq!(registry.lock().unwrap().total, 2);
        assert_eq!(first.key.1.len(), 32);
        drop(second);
        let third = Guard::reserve_in(registry.clone(), &database, "third").unwrap();
        assert_eq!(registry.lock().unwrap().total, 2);
        drop(first);
        drop(third);
        assert_eq!(registry.lock().unwrap().total, 0);
    }

    #[test]
    fn database_identity_is_retained_and_ledger_or_read_failure_stays_generic() {
        let root = tempfile::tempdir().unwrap();
        let database = Arc::new(Mutex::new(
            Store::open(&root.path().join("state.sqlite")).unwrap(),
        ));
        let other = Arc::new(Mutex::new(
            Store::open(&root.path().join("other.sqlite")).unwrap(),
        ));
        let registry = Arc::new(Mutex::new(Registry::default()));
        let guard = Guard::reserve_in(registry.clone(), &database, "same").unwrap();
        let separate = Guard::reserve_in(registry, &other, "same").unwrap();
        assert!(
            separate
                .reject("same", "terminal".into())
                .is::<SendNotAdmitted>()
        );
        assert!(!guard.matches(&other, "same"));
        assert_eq!(Arc::strong_count(&database), 2);
        db(&database, |store| {
            store.db.execute(
                "INSERT INTO requests(id,session_id,text) VALUES ('same','old','once')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        assert!(
            !guard
                .reject("same", "terminal".into())
                .is::<SendNotAdmitted>()
        );
        db(&database, |store| {
            store
                .db
                .execute_batch("ALTER TABLE message_queue RENAME TO unavailable_queue")?;
            Ok(())
        })
        .unwrap();
        let error = guard.reject("same", "terminal".into());
        assert!(!error.is::<SendNotAdmitted>());
        assert!(
            error
                .chain()
                .any(|cause| cause.to_string().contains("no such table"))
        );
    }
}
