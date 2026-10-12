import type { SVGProps } from 'react';

const base = (paths: string[], props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {paths.map((d, i) => (
      <path key={i} d={d} />
    ))}
  </svg>
);

type P = SVGProps<SVGSVGElement>;
export const IconHome = (p: P) => base(['M3 11l9-7 9 7', 'M5 10v10h14V10'], p);
export const IconFlow = (p: P) => base(['M4 6h5v5H4z', 'M15 13h5v5h-5z', 'M9 8.5h3a2 2 0 0 1 2 2v4.5', 'M14 15.5h1'], p);
export const IconNetwork = (p: P) => base(['M12 5a2 2 0 1 0 0 .01', 'M5 18a2 2 0 1 0 0 .01', 'M19 18a2 2 0 1 0 0 .01', 'M11 7l-5 9', 'M13 7l5 9', 'M7 18h10'], p);
export const IconSearch = (p: P) => base(['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'], p);
export const IconUsers = (p: P) => base(['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M2 21v-1a6 6 0 0 1 12 0v1', 'M16 3.5a4 4 0 0 1 0 7.5', 'M22 21v-1a6 6 0 0 0-4-5.6'], p);
export const IconServer = (p: P) => base(['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M8 7h.01', 'M8 17h.01'], p);
export const IconShield = (p: P) => base(['M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z', 'M9 12l2 2 4-4'], p);
export const IconAlert = (p: P) => base(['M12 3l9 16H3z', 'M12 10v4', 'M12 17h.01'], p);
export const IconGrid = (p: P) => base(['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'], p);
export const IconSettings = (p: P) => base(['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'], p);
export const IconLog = (p: P) => base(['M6 3h9l4 4v14H6z', 'M14 3v5h5', 'M9 13h7', 'M9 17h5'], p);
export const IconKey = (p: P) => base(['M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z', 'M16 10h.01'], p);
export const IconPlug = (p: P) => base(['M9 3v5', 'M15 3v5', 'M6 8h12v3a6 6 0 0 1-12 0z', 'M12 17v4'], p);
export const IconTag = (p: P) => base(['M3 12V4h8l9 9-8 8z', 'M7.5 7.5h.01'], p);
export const IconPlus = (p: P) => base(['M12 5v14', 'M5 12h14'], p);
export const IconX = (p: P) => base(['M6 6l12 12', 'M18 6L6 18'], p);
export const IconSave = (p: P) => base(['M5 3h11l3 3v15H5z', 'M8 3v5h7', 'M8 21v-7h8v7'], p);
export const IconLayout = (p: P) => base(['M3 5h6v4H3z', 'M15 5h6v4h-6z', 'M9 17h6v4H9z', 'M6 9v4h12V9', 'M12 13v4'], p);
export const IconLanes = (p: P) => base(['M3 4h18v16H3z', 'M3 9.5h18', 'M3 14.5h18', 'M7 4v16'], p);
export const IconTrash = (p: P) => base(['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'], p);
export const IconDownload = (p: P) => base(['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'], p);
export const IconUpload = (p: P) => base(['M12 20V9', 'M7 14l5-5 5 5', 'M5 4h14'], p);
export const IconMenu = (p: P) => base(['M4 6h16', 'M4 12h16', 'M4 18h16'], p);
export const IconMoon = (p: P) => base(['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'], p);
export const IconLogout = (p: P) => base(['M15 4h4v16h-4', 'M10 8l-4 4 4 4', 'M6 12h10'], p);
export const IconCopy = (p: P) => base(['M9 9h11v11H9z', 'M5 15H4V4h11v1'], p);
export const IconExternal = (p: P) => base(['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'], p);
export const IconCheck = (p: P) => base(['M5 12l5 5 9-10'], p);
export const IconBot = (p: P) => base(['M5 9h14v10H5z', 'M12 5v4', 'M12 4.5h.01', 'M9 13h.01', 'M15 13h.01', 'M9.5 16.5h5', 'M3 13v3', 'M21 13v3'], p);
export const IconMap = (p: P) => base(['M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z', 'M9 4v14', 'M15 6v14'], p);
