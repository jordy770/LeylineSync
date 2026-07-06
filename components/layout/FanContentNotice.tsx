// Legal notice required to distribute Magic-related fan content: the verbatim
// wording prescribed by Wizards of the Coast's Fan Content Policy
// (https://company.wizards.com/en/legal/fancontentpolicy), plus the Scryfall
// data/imagery credit. Shown on the public site pages (landing, collection) —
// not inside the game views.
export default function FanContentNotice() {
  return (
    <p className="mx-auto max-w-3xl px-5 text-center text-[11px] leading-relaxed text-[var(--text-faint,#8a8578)]">
      LeylineSync is unofficial Fan Content permitted under the{' '}
      <a
        href="https://company.wizards.com/en/legal/fancontentpolicy"
        target="_blank"
        rel="noreferrer"
        className="underline decoration-dotted underline-offset-2 hover:text-[var(--text-dim,#b5ae9c)]"
      >
        Fan Content Policy
      </a>
      . Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of
      the Coast. ©Wizards of the Coast LLC. Magic: The Gathering is a trademark of Wizards of the
      Coast LLC. Card data and images courtesy of{' '}
      <a
        href="https://scryfall.com"
        target="_blank"
        rel="noreferrer"
        className="underline decoration-dotted underline-offset-2 hover:text-[var(--text-dim,#b5ae9c)]"
      >
        Scryfall
      </a>
      .
    </p>
  )
}
