// Auto-pass decision — the controller's "should I pass priority right now?"
// logic, extracted as a pure function so it's unit-testable in isolation. The
// controller's effect builds the input from live game state, calls this, then
// adds only the beat timer + the pass_priority RPC around the result.

import type { TurnStep } from './types'

// Per-session auto-pass switches (persisted to localStorage; mirrored to the
// server for pod auto-skip). Each is independent — see shouldAutoPass for how
// they combine.
export type AutoPassSettings = {
  op: boolean   // auto-pass priority on opponents' turns
  own: boolean  // auto-pass your own turn's empty phases (untap/upkeep/draw/begin+end combat/end)
  stk: boolean  // on opponents' turns, STOP when a new object hits the stack
  rsp: boolean  // on opponents' turns, STOP when you hold a castable response
  atk: boolean  // auto-skip Declare Attackers when no creature can legally attack
  blk: boolean  // auto-skip Declare Blockers when you have no block to make (and no held response)
  mn: boolean   // auto-skip your main phase when the stack is empty and nothing is playable
}

// Your own steps with nothing to decide — auto-passed when `own` is on. Main
// phases and the combat decision steps stay manual; their own switches
// (atk/blk/mn) handle the no-op cases.
export const OWN_SKIP_STEPS: TurnStep[] = ['untap', 'upkeep', 'draw', 'beginning_of_combat', 'end_of_combat', 'end']

const isMainPhase = (step: TurnStep) => step === 'precombat_main' || step === 'postcombat_main'

export type AutoPassDecisionInput = {
  step: TurnStep
  /** You are the active (turn) player. */
  isActivePlayer: boolean
  /** Priority is currently yours. */
  hasPriority: boolean
  isSessionFinished: boolean
  /** A pending decision / trigger target you must resolve (the passBlockReason). */
  passBlocked: boolean
  /** "Yield rest of turn" is armed — pass through everything until your next turn. */
  isYielding: boolean
  autoPass: AutoPassSettings
  /** Sorted ids of the pending stack joined to a string ('' when the stack is empty). */
  currentStackKey: string
  /** The stack signature you've already looked at and passed (so it won't re-stop). */
  ackStackKey: string
  /** You hold a castable instant-speed response right now. */
  iHaveResponse: boolean
  /** You control a creature that could legally attack this turn. */
  hasEligibleAttacker: boolean
  /** You're being attacked AND control a creature that could block (a real block to make). */
  hasBlockDecision: boolean
  /** You have something to do in your main phase (land / spell / ability). */
  hasMainPhaseAction: boolean
}

/**
 * Should the controller auto-pass priority right now? Pure mirror of the
 * controller's auto-pass effect. Returns false for every hard exemption and for
 * any step whose governing switch is off; true only when a dead window should be
 * skipped. The caller still owns the beat timer and the pass_priority call.
 */
export function shouldAutoPass(s: AutoPassDecisionInput): boolean {
  // Hard exemptions — never auto-pass through these, even while yielding.
  if (!s.hasPriority || s.isSessionFinished || s.passBlocked) return false
  if (s.step === 'declare_blockers' && s.hasBlockDecision) return false

  if (s.isYielding) return true

  // An object on the stack you haven't acknowledged yet (looked at + passed).
  const stackUnacked = s.currentStackKey !== '' && s.currentStackKey !== s.ackStackKey

  // Declare blockers, either side, with no block to make (a real block was
  // hard-held above). `blk` skips it unless you hold a response or a new object
  // is on the stack.
  if (s.step === 'declare_blockers') {
    let pass = s.autoPass.blk && !s.iHaveResponse
    if (pass && s.autoPass.stk && stackUnacked) pass = false
    return pass
  }

  // Your own turn — each dead window has its own switch.
  if (s.isActivePlayer) {
    return (
      (s.autoPass.own && OWN_SKIP_STEPS.includes(s.step)) ||
      (s.autoPass.atk && s.step === 'declare_attackers' && !s.hasEligibleAttacker) ||
      (s.autoPass.mn && isMainPhase(s.step) && s.currentStackKey === '' && !s.hasMainPhaseAction)
    )
  }

  // Opponents' turns.
  let pass = s.autoPass.op
  if (pass && s.autoPass.stk && stackUnacked) pass = false
  if (pass && s.autoPass.rsp && s.iHaveResponse) pass = false
  return pass
}
