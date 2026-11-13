import React, { useId } from 'react';

/**
 * DeepAutoCode brand mark.
 * Single source of truth for the logo geometry — mirrors `assets/logo.svg`
 * (squircle badge + `< >` code chevrons + autonomous `∞` ribbon + neural spark).
 */
export function BrandMark({
  size = 20,
  radius = 5,
  title = 'DeepAutoCode',
}: {
  size?: number;
  radius?: number;
  title?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const bgId = `dac-bg-${uid}`;
  const rimId = `dac-rim-${uid}`;
  const cyanId = `dac-cyan-${uid}`;
  const violetId = `dac-violet-${uid}`;
  const glowId = `dac-glow-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      role="img"
      aria-label={title}
      style={{ flexShrink: 0, borderRadius: radius }}
    >
      <title>{title}</title>
      <defs>
        <linearGradient id={bgId} x1="64" y1="32" x2="448" y2="480" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#16233F" />
          <stop offset="52%" stopColor="#0A1122" />
          <stop offset="100%" stopColor="#04060D" />
        </linearGradient>
        <linearGradient id={rimId} x1="128" y1="24" x2="384" y2="488" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7DD3FC" stopOpacity="0.7" />
          <stop offset="45%" stopColor="#3B82F6" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0.5" />
        </linearGradient>
        <linearGradient id={cyanId} x1="88" y1="168" x2="424" y2="344" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00F5FF" />
          <stop offset="50%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#2563EB" />
        </linearGradient>
        <linearGradient id={violetId} x1="150" y1="200" x2="362" y2="312" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#38BDF8" />
          <stop offset="50%" stopColor="#818CF8" />
          <stop offset="100%" stopColor="#C084FC" />
        </linearGradient>
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#E0F2FE" stopOpacity="1" />
          <stop offset="35%" stopColor="#00F0FF" stopOpacity="0.85" />
          <stop offset="75%" stopColor="#3B82F6" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#3B82F6" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect x="28" y="28" width="456" height="456" rx="108" fill={`url(#${bgId})`} stroke={`url(#${rimId})`} strokeWidth="8" />
      <rect x="44" y="44" width="424" height="424" rx="94" stroke="#93C5FD" strokeOpacity="0.12" strokeWidth="2" />

      <path
        d="M188 164 L96 256 L188 348"
        stroke={`url(#${cyanId})`}
        strokeWidth="24"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M324 164 L416 256 L324 348"
        stroke={`url(#${cyanId})`}
        strokeWidth="24"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M196 196 C228 196, 284 316, 316 316 C348 316, 368 288, 368 256 C368 224, 348 196, 316 196 C284 196, 228 316, 196 316 C164 316, 144 288, 144 256 C144 224, 164 196, 196 196 Z"
        stroke={`url(#${violetId})`}
        strokeWidth="16"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <circle cx="256" cy="256" r="56" fill={`url(#${glowId})`} />
      <path d="M256 172 L267 245 L340 256 L267 267 L256 340 L245 267 L172 256 L245 245 Z" fill="#E0F2FE" />
      <circle cx="256" cy="256" r="14" fill="#FFFFFF" />
    </svg>
  );
}

export default BrandMark;
