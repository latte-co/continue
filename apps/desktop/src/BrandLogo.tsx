import { useEffect, useId, useRef, useState } from "react";
import type { Status } from "./protocol";

const C_RING_PATH =
  "M63.2441 7C85.8937 -1.95166 111.032 -2.3304 133.94 5.93555C156.849 14.2016 175.954 30.5441 187.67 51.8955L145.472 75.0488C140.421 58.3573 130.462 47 119 47C111.315 47 104.308 52.1057 99 60.5C93.6922 52.1057 86.6845 47 79 47C62.4315 47 49 70.7289 49 100C49 129.271 62.4315 153 79 153C86.6847 153 93.6921 147.894 99 139.499C104.308 147.894 111.315 153 119 153C135.569 153 149 129.271 149 100H200C200 124.354 191.112 147.872 175.005 166.139C158.897 184.405 136.677 196.166 112.514 199.214C88.3507 202.261 63.9055 196.387 43.7666 182.691C23.6278 168.996 9.17904 148.422 3.13184 124.83C-2.91531 101.238 -0.144858 76.2501 10.9229 54.5557C21.9906 32.8614 40.5946 15.9517 63.2441 7Z";

const LEFT_PUPIL_PATH =
  "M60.2822 93.793C63.253 91.6714 66.8957 90.7064 70.5273 91.0781C74.1591 91.4499 77.5314 93.1337 80.0107 95.8135L69 106L83.5664 102.42C84.4377 105.965 83.9865 109.706 82.2969 112.942C80.6072 116.179 77.7948 118.688 74.3877 119.999C70.9806 121.31 67.2124 121.334 63.7891 120.065C60.3657 118.797 57.5223 116.324 55.792 113.109C54.0617 109.895 53.563 106.159 54.3896 102.604C55.2163 99.0476 57.3114 95.9147 60.2822 93.793Z";

const RIGHT_PUPIL_PATH =
  "M100.282 93.793C103.253 91.6714 106.896 90.7064 110.527 91.0781C114.159 91.4499 117.531 93.1337 120.011 95.8135L109 106L123.566 102.42C124.438 105.965 123.986 109.706 122.297 112.942C120.607 116.179 117.795 118.688 114.388 119.999C110.981 121.31 107.212 121.334 103.789 120.065C100.366 118.797 97.5223 116.324 95.792 113.109C94.0617 109.895 93.563 106.159 94.3896 102.604C95.2163 99.0476 97.3114 95.9147 100.282 93.793Z";

export type BrandLogoMood = "idle" | "working" | "waiting" | "done";

const LOGO_INK = "#111113";
const LOGO_PAPER = "#FFFFFF";

/**
 * Stateful vector mark for Continue, preserving the exact original figure-ground
 * palette (`#FFFFFF` tile & sclera + `#111113` geometric `C` & pie-cut pupils)
 * across all light and dark themes without inverting black and white.
 */
export function BrandLogo({
  sessionKey,
  status,
  size = 18,
}: {
  sessionKey?: string;
  status?: Status;
  size?: number;
}) {
  const clipId = useId();
  const prevRef = useRef<{ key?: string; status?: Status }>({
    key: sessionKey,
    status,
  });
  const [celebrating, setCelebrating] = useState(false);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { key: sessionKey, status };
    if (
      prev.key === sessionKey &&
      (prev.status === "running" || prev.status === "waiting") &&
      status === "completed"
    ) {
      setCelebrating(true);
      const timer = window.setTimeout(() => setCelebrating(false), 900);
      return () => window.clearTimeout(timer);
    }
    setCelebrating(false);
    return undefined;
  }, [sessionKey, status]);

  const mood: BrandLogoMood = celebrating
    ? "done"
    : status === "running"
      ? "working"
      : status === "waiting"
        ? "waiting"
        : "idle";

  return (
    <span className="brand-mark" data-mood={mood} aria-hidden="true">
      <svg
        width={size}
        height={size}
        viewBox="0 0 200 200"
        fill="none"
        className="brand-logo-svg"
      >
        <defs>
          <clipPath id={clipId}>
            <ellipse cx="79" cy="100" rx="30" ry="53" />
            <ellipse cx="119" cy="100" rx="30" ry="53" />
          </clipPath>
        </defs>
        <path d={C_RING_PATH} fill={LOGO_INK} />
        <g clipPath={`url(#${clipId})`}>
          <g className="brand-logo-gaze">
            <g className="brand-logo-pupils">
              <path d={LEFT_PUPIL_PATH} fill={LOGO_INK} />
              <path d={RIGHT_PUPIL_PATH} fill={LOGO_INK} />
              {/* White 4-point star glint inside the black right pupil (#5 GIF) */}
              <path
                className="brand-logo-sparkle"
                d="M109 96L111.2 103.8L119 106L111.2 108.2L109 116L106.8 108.2L99 106L106.8 103.8Z"
                fill={LOGO_PAPER}
              />
            </g>
            {/* Calm downward blink arcs (#5 GIF) */}
            <g className="brand-logo-blink-lids">
              <path
                d="M56 106Q69 115 82 106"
                stroke={LOGO_INK}
                strokeWidth="10"
                strokeLinecap="round"
              />
              <path
                d="M96 106Q109 115 122 106"
                stroke={LOGO_INK}
                strokeWidth="10"
                strokeLinecap="round"
              />
            </g>
            {/* Brief happy crescent eyes on turn completion (#3 GIF) */}
            <g className="brand-logo-happy-lids">
              <path
                d="M56 109Q69 94 82 109"
                stroke={LOGO_INK}
                strokeWidth="10.5"
                strokeLinecap="round"
              />
              <path
                d="M96 109Q109 94 122 109"
                stroke={LOGO_INK}
                strokeWidth="10.5"
                strokeLinecap="round"
              />
            </g>
          </g>
        </g>
      </svg>
    </span>
  );
}
