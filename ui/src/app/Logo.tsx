/** MoleculeForge mark: an anvil-shaped hexagon (benzene ring) struck by an ember spark. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="MoleculeForge">
      <rect width="64" height="64" rx="16" className="fill-ink" />
      <path d="M32 12 49.3 22v20L32 52 14.7 42V22Z" fill="none" className="stroke-bg" strokeWidth="3.2" strokeLinejoin="round" />
      <path d="M32 19.5 42.8 25.7v12.6L32 44.5 21.2 38.3V25.7Z" fill="none" className="stroke-bg" strokeOpacity="0.45" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="32" cy="32" r="5.2" className="fill-accent" />
      <path d="M43 15.5 47.5 11M47 21l6-1.6M38.5 13l1-6" className="stroke-accent" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
