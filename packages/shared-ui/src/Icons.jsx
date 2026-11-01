import React from 'react';

function base({ size = 16, className, children, filled = false, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={filled ? undefined : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...rest}
    >
      {children}
    </svg>
  );
}

export function NoteIcon(props) {
  return base({ ...props, children: (
    <>
      <path d="M9 18V6l10-2v11" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="15" r="2.5" />
    </>
  )});
}

export function SettingsIcon(props) {
  return base({ ...props, children: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8" />
    </>
  )});
}

export function SunIcon(props) {
  return base({ ...props, children: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  )});
}

export function MoonIcon(props) {
  return base({ ...props, children: (
    <path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5Z" />
  )});
}

export function PlayIcon(props) {
  return (
    <svg width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" className={props.className}>
      <path d="M8 5.5v13l11-6.5-11-6.5Z" />
    </svg>
  );
}

export function PauseIcon(props) {
  return base({ ...props, children: (
    <>
      <path d="M9 5v14M15 5v14" />
    </>
  )});
}

export function DownloadIcon(props) {
  return base({ ...props, children: (
    <>
      <path d="M12 3v11m0 0 4-4m-4 4-4-4" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </>
  )});
}

export function PencilIcon(props) {
  return base({ ...props, children: (
    <>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4.5 1.5L5 15 16.5 3.5Z" />
    </>
  )});
}

export function RetryIcon(props) {
  return base({ ...props, children: (
    <>
      <path d="M3 12a9 9 0 1 0 2.6-6.4" />
      <path d="M3 4v5h5" />
    </>
  )});
}

export function XIcon(props) {
  return base({ ...props, children: (
    <path d="M6 6l12 12M18 6 6 18" />
  )});
}

export function SearchIcon(props) {
  return base({ ...props, children: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  )});
}

export function ArrowUpIcon(props) {
  return base({ ...props, children: (
    <>
      <path d="M12 19V5m0 0-6 6m6-6 6 6" />
    </>
  )});
}

export function ArrowDownIcon(props) {
  return base({ ...props, children: (
    <>
      <path d="M12 5v14m0 0 6-6m-6 6-6-6" />
    </>
  )});
}

export function ListIcon(props) {
  return base({ ...props, children: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </>
  )});
}

export function GridIcon(props) {
  return base({ ...props, children: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  )});
}

export function CheckIcon(props) {
  return base({ ...props, children: (
    <path d="m4.5 12.5 5 5 10-11" />
  )});
}

export function AlertIcon(props) {
  return base({ ...props, children: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V13" />
      <path d="M12 16.5h.01" />
    </>
  )});
}

export function ChevronDownIcon(props) {
  return base({ ...props, children: (
    <path d="m6 9 6 6 6-6" />
  )});
}

export function FolderIcon(props) {
  return base({ ...props, children: (
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 16.5v-10Z" />
  )});
}

export function FolderOpenIcon(props) {
  return base({ ...props, children: (
    <>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h7A1.5 1.5 0 0 1 19 9H3v7.5" />
      <path d="M3 9h16v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 16.5V9Z" opacity="0" />
    </>
  )});
}
