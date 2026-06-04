export default function EmptyBoardPanel() {
  return (
    <div className="leyline-glass-panel col-span-full flex min-h-[24rem] items-center justify-center rounded-lg border-dashed text-sm text-slate-500 [@media(max-height:640px)]:min-h-[calc(100svh-8rem)]">
      Waiting for players to join the session.
    </div>
  )
}
