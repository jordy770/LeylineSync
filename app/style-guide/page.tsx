// Living style guide for the Leyline identity. Renders the real tokens (from
// globals.css) and real component patterns, so it can't drift from the app.

import type { ReactNode } from "react";

export const metadata = { title: "Leyline · Style Guide" };

// ── small building blocks ──────────────────────────────────────────────────
function Section({ id, n, title, children }: { id: string; n: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-[var(--frame-gold)]/15 pt-10">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="font-mono text-xs text-[var(--text-faint)]">{n}</span>
        <h2 className="font-display text-2xl tracking-wide text-[var(--gold-bright)]">{title}</h2>
      </header>
      {children}
    </section>
  );
}

function Swatch({ name, varName, hex, ink }: { name: string; varName: string; hex: string; ink?: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border border-white/10">
      <div className="h-16 w-full" style={{ background: hex }} />
      <div className="bg-[var(--ink-2)] px-2.5 py-2">
        <p className="text-[13px] font-medium" style={{ color: ink ? "#fff" : "var(--text)" }}>{name}</p>
        <p className="font-mono text-[10px] text-[var(--text-faint)]">{hex}</p>
        <p className="font-mono text-[10px] text-[var(--frame-gold)]/80">{varName}</p>
      </div>
    </div>
  );
}

function Swatches({ items }: { items: { name: string; varName: string; hex: string; ink?: boolean }[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((s) => <Swatch key={s.varName} {...s} />)}
    </div>
  );
}

function Pip({ letter, color, dark }: { letter: string; color: string; dark?: boolean }) {
  return (
    <span
      className="grid h-7 w-7 place-items-center rounded-full font-mono text-xs font-bold shadow-[inset_0_1px_1px_rgba(255,255,255,0.4),0_1px_3px_rgba(0,0,0,0.4)]"
      style={{ background: color, color: dark ? "#1a1714" : "#f4efdd" }}
    >
      {letter}
    </span>
  );
}

function Specimen({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/5 py-3">
      <div className={className}>{children}</div>
      <span className="shrink-0 font-mono text-[10px] text-[var(--text-faint)]">{label}</span>
    </div>
  );
}

export default function StyleGuidePage() {
  return (
    <main className="landing-void relative min-h-screen overflow-hidden text-[var(--text)]">
      <div className="ley-grid pointer-events-none absolute inset-0" />
      <div className="relative mx-auto max-w-4xl px-5 pb-28">
        {/* Header */}
        <header className="pt-16 text-center">
          <p className="font-display text-[11px] uppercase tracking-[0.42em] text-[var(--frame-gold)]">
            Leyline
          </p>
          <div className="mt-3 flex items-center justify-center gap-2">
            {[["W", "var(--mana-w)", true], ["U", "var(--mana-u)"], ["B", "var(--mana-b)"], ["R", "var(--mana-r)"], ["G", "var(--mana-g)"]].map(
              ([l, c, d]) => <Pip key={l as string} letter={l as string} color={c as string} dark={Boolean(d)} />,
            )}
          </div>
          <h1 className="mt-6 font-display text-4xl tracking-wide text-[#f3ead2] sm:text-5xl">Style Guide</h1>
          <p className="mx-auto mt-4 max-w-lg font-rules text-[15px] leading-relaxed text-[var(--text-dim)]">
            The visual system behind LeylineSync — an arcane void, card-stock parchment, and a
            heraldic gold frame. Every value here is a CSS token in <code className="font-mono text-[13px] text-[var(--frame-gold)]">globals.css</code>.
          </p>
        </header>

        <div className="mt-16 space-y-14">
          {/* COLOUR */}
          <Section id="colour" n="01" title="Colour">
            <p className="mb-4 font-rules text-sm text-[var(--text-dim)]">Ground &amp; surfaces</p>
            <Swatches items={[
              { name: "Void", varName: "--void", hex: "#0b0a12" },
              { name: "Ink panel", varName: "--ink-2", hex: "#15111f" },
              { name: "Warm plate", varName: "--ink-warm", hex: "#16100a" },
              { name: "Parchment", varName: "--parchment", hex: "#ece3cd", ink: true },
              { name: "Parchment edge", varName: "--parchment-2", hex: "#d8cba9", ink: true },
            ]} />
            <p className="mb-4 mt-8 font-rules text-sm text-[var(--text-dim)]">Gold &amp; text</p>
            <Swatches items={[
              { name: "Frame gold", varName: "--frame-gold", hex: "#c99a3a" },
              { name: "Gold bright", varName: "--gold-bright", hex: "#f0ce78", ink: true },
              { name: "Text", varName: "--text", hex: "#e9dfc6", ink: true },
              { name: "Text dim", varName: "--text-dim", hex: "#bcae8e", ink: true },
              { name: "Text faint", varName: "--text-faint", hex: "#8b7f63" },
            ]} />
            <p className="mb-4 mt-8 font-rules text-sm text-[var(--text-dim)]">
              The five colours of mana — a structural accent, not a rainbow
            </p>
            <Swatches items={[
              { name: "White", varName: "--mana-w", hex: "#f4efdd", ink: true },
              { name: "Blue", varName: "--mana-u", hex: "#2e6fc9" },
              { name: "Black", varName: "--mana-b", hex: "#4a3b5c" },
              { name: "Red", varName: "--mana-r", hex: "#c0402b" },
              { name: "Green", varName: "--mana-g", hex: "#3c7a4e" },
            ]} />
            <p className="mb-4 mt-8 font-rules text-sm text-[var(--text-dim)]">Semantic</p>
            <Swatches items={[
              { name: "Cast / go", varName: "--cast", hex: "#3c7a4e" },
              { name: "Warn", varName: "--warn", hex: "#d9a53b", ink: true },
              { name: "Danger", varName: "--danger", hex: "#c0402b" },
            ]} />
          </Section>

          {/* TYPE */}
          <Section id="type" n="02" title="Typography">
            <div className="grid gap-6 sm:grid-cols-3">
              {[
                { face: "Cinzel", role: "Display", use: "Titles, eyebrows, section heads. Engraved Roman caps — the card title plate.", cls: "font-display text-2xl tracking-wide text-[var(--gold-bright)]", sample: "Leyline" },
                { face: "Spectral", role: "Rules / body", use: "Body copy, flavor, descriptions. A literary serif standing in for card rules text.", cls: "font-rules text-2xl text-[var(--text)]", sample: "Rules text" },
                { face: "Geist", role: "Interface", use: "Buttons, inputs, labels, data. The neutral working face for dense controls.", cls: "text-2xl font-semibold text-[var(--text)]", sample: "Controls" },
              ].map((f) => (
                <div key={f.face} className="rounded-lg border border-white/10 bg-[var(--ink-2)] p-4">
                  <p className={f.cls}>{f.sample}</p>
                  <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-[var(--frame-gold)]">{f.role} · {f.face}</p>
                  <p className="mt-1 font-rules text-[13px] leading-snug text-[var(--text-dim)]">{f.use}</p>
                </div>
              ))}
            </div>

            <div className="mt-8 rounded-lg border border-white/10 bg-[var(--ink-2)] px-5 py-2">
              <Specimen label="Cinzel · display"><span className="font-display text-4xl tracking-wide text-[#f3ead2]">Where the leylines cross</span></Specimen>
              <Specimen label="Cinzel · heading"><span className="font-display text-2xl tracking-wide text-[var(--gold-bright)]">The Table</span></Specimen>
              <Specimen label="Spectral · lede"><span className="font-rules text-lg text-[var(--text)]">One board on the big screen, a controller in every hand.</span></Specimen>
              <Specimen label="Spectral · body"><span className="font-rules text-[15px] text-[var(--text-dim)]">Cast from your phone and watch it resolve on the screen.</span></Specimen>
              <Specimen label="Geist · label"><span className="text-sm font-semibold text-[var(--text)]">Create game</span></Specimen>
              <Specimen label="mono · caption"><span className="font-mono text-xs text-[var(--text-faint)]">LS · 001 · M</span></Specimen>
            </div>
          </Section>

          {/* SHAPE & ELEVATION */}
          <Section id="shape" n="03" title="Shape & elevation">
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="rounded-lg border border-white/10 bg-[var(--ink-2)] p-5">
                <p className="mb-3 font-mono text-[11px] uppercase tracking-wider text-[var(--frame-gold)]">Radius</p>
                <div className="flex flex-wrap items-end gap-4">
                  {[["sm", "rounded-md", "6px"], ["md", "rounded-lg", "8px"], ["lg", "rounded-xl", "12px"], ["xl", "rounded-2xl", "16px"], ["card", "rounded-[20px]", "20px"]].map(([n, cls, px]) => (
                    <div key={n} className="text-center">
                      <div className={`h-12 w-12 border border-[var(--frame-gold)]/50 bg-[var(--frame-gold)]/10 ${cls}`} />
                      <p className="mt-1 font-mono text-[10px] text-[var(--text-faint)]">{px}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-white/10 bg-[var(--ink-2)] p-5">
                <p className="mb-3 font-mono text-[11px] uppercase tracking-wider text-[var(--frame-gold)]">Elevation</p>
                <div className="flex flex-wrap items-center gap-5">
                  <div className="grid h-14 w-20 place-items-center rounded-lg bg-[var(--ink-2)] ring-1 ring-white/10 font-mono text-[10px] text-[var(--text-faint)]">flat</div>
                  <div className="grid h-14 w-20 place-items-center rounded-lg bg-[var(--ink-2)] shadow-xl shadow-black/40 font-mono text-[10px] text-[var(--text-faint)]">panel</div>
                  <div className="card-frame grid h-14 w-20 place-items-center rounded-lg font-mono text-[10px] text-[#2a2010]">card</div>
                </div>
              </div>
            </div>
          </Section>

          {/* COMPONENTS */}
          <Section id="components" n="04" title="Components">
            {/* Buttons */}
            <p className="mb-3 font-rules text-sm text-[var(--text-dim)]">Buttons — one job each; the label is the outcome</p>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-[var(--ink-2)] p-5">
              <button className="rounded-lg bg-[var(--cast)] px-5 py-2.5 text-sm font-bold text-emerald-50 shadow-lg shadow-emerald-900/30">Create game</button>
              <button className="rounded-lg bg-white px-4 py-2.5 text-sm font-bold text-slate-950">Join</button>
              <button className="rounded-full border border-[var(--frame-gold)]/40 bg-[var(--frame-gold)]/10 px-5 py-2 font-display text-xs uppercase tracking-[0.2em] text-[var(--gold-bright)]">Find your table</button>
              <button className="rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-[var(--text)]">Manage</button>
              <button className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-4 py-2.5 text-sm font-semibold text-red-300">Finish</button>
            </div>

            {/* Badges & pips */}
            <p className="mb-3 mt-8 font-rules text-sm text-[var(--text-dim)]">Status &amp; mana</p>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-[var(--ink-2)] p-5">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" />Lobby</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Playing</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-500/30 bg-slate-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-slate-400"><span className="h-1.5 w-1.5 rounded-full bg-slate-500" />Finished</span>
              <span className="ml-2 flex items-center gap-1.5">
                <Pip letter="W" color="var(--mana-w)" dark /><Pip letter="U" color="var(--mana-u)" /><Pip letter="B" color="var(--mana-b)" /><Pip letter="R" color="var(--mana-r)" /><Pip letter="G" color="var(--mana-g)" />
              </span>
            </div>

            {/* Inputs */}
            <p className="mb-3 mt-8 font-rules text-sm text-[var(--text-dim)]">Inputs</p>
            <div className="grid gap-3 rounded-lg border border-white/10 bg-[var(--ink-2)] p-5 sm:grid-cols-2">
              <input placeholder="Session ID" className="rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 font-mono text-sm text-[var(--text)] outline-none focus:border-[var(--frame-gold)]/60" />
              <select className="rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-[var(--text)] outline-none focus:border-[var(--frame-gold)]/60">
                <option>Mono Green Stompy (60)</option>
              </select>
            </div>

            {/* Surfaces */}
            <p className="mb-3 mt-8 font-rules text-sm text-[var(--text-dim)]">Surfaces — dark panel & the parchment textbox</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-[var(--ink-2)] p-5">
                <p className="font-display text-sm uppercase tracking-[0.2em] text-[var(--frame-gold)]">Panel</p>
                <p className="mt-2 font-rules text-sm text-[var(--text-dim)]">Raised dark surface for the games hub, action sheets, and lists.</p>
              </div>
              <div className="card-frame rounded-2xl p-[6px]">
                <div className="card-parchment rounded-[14px] p-4 text-[var(--parchment-ink)]">
                  <p className="font-rules text-sm">Parchment carries anything you read closely — card rules, flavor, help.</p>
                  <p className="mt-2 border-l-2 border-[#9c8c63]/40 pl-2 font-rules text-[13px] italic text-[#5a4f33]">The table remembers every spell.</p>
                </div>
              </div>
            </div>
          </Section>

          {/* VOICE */}
          <Section id="voice" n="05" title="Voice">
            <p className="mb-4 max-w-xl font-rules text-[15px] leading-relaxed text-[var(--text-dim)]">
              Plain verbs, sentence case, no filler. Name things by what a player controls. A button
              says the outcome and keeps that word through the whole flow.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { good: "Create game", bad: "Initialize session", why: "Name the action, not the system." },
                { good: "That username is already taken", bad: "Error: unique constraint violation", why: "Say what happened and what to do." },
                { good: "No games yet — create a table above", bad: "Empty", why: "An empty screen is an invitation to act." },
                { good: "Release to play", bad: "Submit", why: "Same verb the gesture promised." },
              ].map((r) => (
                <div key={r.good} className="rounded-lg border border-white/10 bg-[var(--ink-2)] p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-emerald-300"><span className="text-emerald-500">✓</span>{r.good}</p>
                  <p className="mt-1 flex items-center gap-2 text-sm text-[var(--text-faint)] line-through"><span className="text-[var(--danger)] no-underline">✕</span>{r.bad}</p>
                  <p className="mt-2 font-rules text-[13px] text-[var(--text-dim)]">{r.why}</p>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </main>
  );
}
