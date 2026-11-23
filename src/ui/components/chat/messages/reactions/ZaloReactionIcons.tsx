import React from 'react';
import { displayReactionEmoji } from './ReactionComponents';

type ZaloReactionKind = 'like' | 'heart' | 'haha' | 'wow' | 'cry' | 'angry';

function resolveZaloReactionKind(emoji: string): ZaloReactionKind | null {
  switch (emoji) {
    case '👍':
    case '👍️':
    case '👍︎':
      return 'like';
    case '❤️':
    case '❤':
    case '❤︎':
      return 'heart';
    case '😆':
    case '😄':
    case '😂':
      return 'haha';
    case '😮':
    case '😮️':
      return 'wow';
    case '😭':
    case '😢':
    case '😢️':
      return 'cry';
    case '😡':
    case '😡️':
      return 'angry';
    default:
      return null;
  }
}

export interface ZaloReactionGlyphProps {
  emoji: string;
  size?: number;
  className?: string;
}

/**
 * Glossy 3D Zalo-style SVG glyphs for the 6 signature reactions (👍 ❤️ 😆 😮 😭 😡).
 * Replaces thick-bordered monochrome/cartoon Windows Segoe UI Emoji glyphs; falls back to
 * displayReactionEmoji() for any other emoji (e.g. Telegram extended reactions).
 */
export function ZaloReactionGlyph({ emoji, size = 24, className = '' }: ZaloReactionGlyphProps) {
  const rawId = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const kind = resolveZaloReactionKind(emoji);

  if (!kind) {
    return (
      <span
        className={`inline-flex items-center justify-center leading-none select-none ${className}`}
        style={{ fontSize: Math.round(size * 0.85), width: size, height: size }}
      >
        {displayReactionEmoji(emoji)}
      </span>
    );
  }

  const gid = `${kind}-${rawId}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={`inline-block flex-shrink-0 select-none ${className}`}
    >
      {kind === 'like' && (
        <>
          <defs>
            <linearGradient id={`${gid}-hand`} x1="10" y1="4" x2="26" y2="28" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#FFE169" />
              <stop offset="52%" stopColor="#FFB82E" />
              <stop offset="100%" stopColor="#E68A00" />
            </linearGradient>
            <linearGradient id={`${gid}-cuff`} x1="4" y1="14" x2="10" y2="28" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#F8C146" />
              <stop offset="100%" stopColor="#D67C00" />
            </linearGradient>
          </defs>
          <rect x="4.5" y="14" width="5.5" height="13" rx="2" fill={`url(#${gid}-cuff)`} />
          <path
            d="M11 13.8L14.9 6.3C15.5 5.1 17 4.6 18.2 5.1C19.3 5.6 19.9 6.8 19.6 8.1L18.6 12.2H24.4C26.2 12.2 27.6 13.7 27.4 15.5L26.2 24.4C26 25.9 24.7 27 23.2 27H12.2C11.4 27 11 26.4 11 25.6V13.8Z"
            fill={`url(#${gid}-hand)`}
          />
          <path d="M13 15.5H23.5" stroke="#FFF4B8" strokeWidth="1.2" strokeLinecap="round" opacity="0.55" />
          <circle cx="7.2" cy="24.2" r="0.9" fill="#FFF7CC" opacity="0.85" />
        </>
      )}

      {kind === 'heart' && (
        <>
          <defs>
            <radialGradient id={`${gid}-bg`} cx="35%" cy="28%" r="72%">
              <stop offset="0%" stopColor="#FF7A7A" />
              <stop offset="48%" stopColor="#EF2D34" />
              <stop offset="100%" stopColor="#B80D1B" />
            </radialGradient>
          </defs>
          <path
            d="M16 28.2C15.5 28.2 15.1 28 14.7 27.7C8.2 22.4 3.5 17.7 3.5 11.7C3.5 7.4 6.8 4.2 10.9 4.2C13.2 4.2 15.1 5.3 16 6.8C16.9 5.3 18.8 4.2 21.1 4.2C25.2 4.2 28.5 7.4 28.5 11.7C28.5 17.7 23.8 22.4 17.3 27.7C16.9 28 16.5 28.2 16 28.2Z"
            fill={`url(#${gid}-bg)`}
          />
          <ellipse cx="10.2" cy="9.4" rx="2.6" ry="1.4" transform="rotate(-32 10.2 9.4)" fill="#FFFFFF" opacity="0.45" />
        </>
      )}

      {kind === 'haha' && (
        <>
          <defs>
            <radialGradient id={`${gid}-face`} cx="35%" cy="30%" r="72%">
              <stop offset="0%" stopColor="#FFE97D" />
              <stop offset="60%" stopColor="#FFC136" />
              <stop offset="100%" stopColor="#EE9408" />
            </radialGradient>
            <linearGradient id={`${gid}-mouth`} x1="16" y1="16" x2="16" y2="27" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#7A1D12" />
              <stop offset="100%" stopColor="#4A0C07" />
            </linearGradient>
          </defs>
          <circle cx="16" cy="16" r="13.5" fill={`url(#${gid}-face)`} />
          <g transform="rotate(-8 16 16)">
            <path d="M8.5 11.2L12.7 13L8.5 14.8" stroke="#4D2407" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M23.5 11.2L19.3 13L23.5 14.8" stroke="#4D2407" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M8.4 17.3H23.6C23.8 22.5 20.6 25.8 16 25.8C11.4 25.8 8.2 22.5 8.4 17.3Z" fill={`url(#${gid}-mouth)`} />
            <path d="M9.4 17.3H22.6C22.4 19 21.8 19.6 20.8 19.6H11.2C10.2 19.6 9.6 19 9.4 17.3Z" fill="#FFFFFF" />
            <path d="M11.6 23.6C12.7 22.1 14.2 21.4 16 21.4C17.8 21.4 19.3 22.1 20.4 23.6C19.1 24.9 17.6 25.5 16 25.5C14.4 25.5 12.9 24.9 11.6 23.6Z" fill="#FF6B6B" />
          </g>
        </>
      )}

      {kind === 'wow' && (
        <>
          <defs>
            <radialGradient id={`${gid}-face`} cx="35%" cy="30%" r="72%">
              <stop offset="0%" stopColor="#FFE97D" />
              <stop offset="60%" stopColor="#FFC136" />
              <stop offset="100%" stopColor="#EE9408" />
            </radialGradient>
          </defs>
          <circle cx="16" cy="16" r="13.5" fill={`url(#${gid}-face)`} />
          <path d="M8.2 9.4C9.5 8 11.5 7.8 12.8 8.8" stroke="#7A4412" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M23.8 9.4C22.5 8 20.5 7.8 19.2 8.8" stroke="#7A4412" strokeWidth="1.7" strokeLinecap="round" />
          <ellipse cx="10.8" cy="14" rx="2.6" ry="3.2" fill="#FFFFFF" />
          <ellipse cx="21.2" cy="14" rx="2.6" ry="3.2" fill="#FFFFFF" />
          <circle cx="11.1" cy="14.2" r="1.4" fill="#2A1B0E" />
          <circle cx="20.9" cy="14.2" r="1.4" fill="#2A1B0E" />
          <ellipse cx="16" cy="22.8" rx="3.1" ry="4" fill="#63220F" />
          <ellipse cx="16" cy="24.9" rx="1.6" ry="1.1" fill="#E35D52" />
        </>
      )}

      {kind === 'cry' && (
        <>
          <defs>
            <radialGradient id={`${gid}-face`} cx="35%" cy="30%" r="72%">
              <stop offset="0%" stopColor="#FFE97D" />
              <stop offset="60%" stopColor="#FFC136" />
              <stop offset="100%" stopColor="#EE9408" />
            </radialGradient>
            <linearGradient id={`${gid}-tear`} x1="0" y1="14" x2="0" y2="28" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#65D6FF" />
              <stop offset="100%" stopColor="#1282F6" />
            </linearGradient>
          </defs>
          <circle cx="16" cy="16" r="13.5" fill={`url(#${gid}-face)`} />
          <path d="M8.4 13.2L12.8 14.3L12.8 27.6C10.9 26.8 9.5 25.5 8.4 23.9V13.2Z" fill={`url(#${gid}-tear)`} />
          <path d="M23.6 13.2L19.2 14.3L19.2 27.6C21.1 26.8 22.5 25.5 23.6 23.9V13.2Z" fill={`url(#${gid}-tear)`} />
          <path d="M8 10.6C9.5 10.3 11.4 9.5 12.6 8.3" stroke="#6B3A10" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M24 10.6C22.5 10.3 20.6 9.5 19.4 8.3" stroke="#6B3A10" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M8.5 13.5C9.8 14.7 11.8 14.7 13 13.5" stroke="#4D2407" strokeWidth="2" strokeLinecap="round" />
          <path d="M19 13.5C20.2 14.7 22.2 14.7 23.5 13.5" stroke="#4D2407" strokeWidth="2" strokeLinecap="round" />
          <path d="M12 22.5C12.8 19.9 19.2 19.9 20 22.5C19.5 24.4 12.5 24.4 12 22.5Z" fill="#63220F" />
        </>
      )}

      {kind === 'angry' && (
        <>
          <defs>
            <radialGradient id={`${gid}-face`} cx="35%" cy="28%" r="72%">
              <stop offset="0%" stopColor="#FF9654" />
              <stop offset="52%" stopColor="#F14C2C" />
              <stop offset="100%" stopColor="#B81D13" />
            </radialGradient>
          </defs>
          <circle cx="16" cy="16" r="13.5" fill={`url(#${gid}-face)`} />
          <path d="M8.5 11.5L13.5 14.2" stroke="#4A0B05" strokeWidth="2.1" strokeLinecap="round" />
          <path d="M23.5 11.5L18.5 14.2" stroke="#4A0B05" strokeWidth="2.1" strokeLinecap="round" />
          <circle cx="11.1" cy="15.8" r="1.7" fill="#3B0804" />
          <circle cx="20.9" cy="15.8" r="1.7" fill="#3B0804" />
          <path d="M11.6 22.8C13.2 20.8 18.8 20.8 20.4 22.8" stroke="#4A0B05" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M23 5.5L22.3 8L24.8 7.3M25.6 9.5L23.2 9.5" stroke="#FFD67A" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}
