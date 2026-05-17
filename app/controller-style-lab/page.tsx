'use client'

import { useRef, useState } from 'react'
import styles from './controller-style-lab.module.css'

const handCards = [
  { name: 'Counterspell', type: 'Instant', cost: 'UU' },
  { name: 'Island', type: 'Land', cost: '' },
  { name: 'Opt', type: 'Instant', cost: 'U' },
  { name: 'Snapcaster Mage', type: 'Creature', cost: '1U' },
  { name: 'Lightning Bolt', type: 'Instant', cost: 'R' },
]

const boardCards = [
  { name: 'Island', tapped: true },
  { name: 'Island', tapped: false },
  { name: 'Steam Vents', tapped: false },
  { name: 'Ledger Shredder', tapped: false },
]

const opponentCards = [
  { name: 'Swamp', tapped: true },
  { name: 'Orcish Bowmasters', tapped: false },
  { name: 'Blood Crypt', tapped: false },
  { name: 'Ragavan', tapped: true },
]

const stackItems = [
  { title: 'Fatal Push', owner: 'Opponent 2', target: 'Ledger Shredder' },
  { title: 'Counterspell', owner: 'You', target: 'Fatal Push' },
]

export default function ControllerStyleLabPage() {
  return (
    <main className={styles.page}>
      <div className={styles.portraitNotice}>
        <h1>Landscape first</h1>
        <p>Draai je telefoon om de controller-richtingen te bekijken.</p>
      </div>

      <section className={styles.lab}>
        <header className={styles.labHeader}>
          <div>
            <p className={styles.kicker}>LeylineSync Controller Style Lab</p>
            <h1>3 landscape controller richtingen</h1>
          </div>
          <p className={styles.headerNote}>Fake data. Geen database. Alleen UX, flow en visuele richting.</p>
        </header>

        <div className={styles.prototypeGrid}>
          <MinimalHud />
          <CardTable />
          <StackResponder />
        </div>
      </section>
    </main>
  )
}

function MinimalHud() {
  const [selectedCard, setSelectedCard] = useState<(typeof handCards)[number] | null>(null)
  const [inspectedCard, setInspectedCard] = useState<(typeof handCards)[number] | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const didLongPress = useRef(false)

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  const startCardPress = (card: (typeof handCards)[number]) => {
    didLongPress.current = false
    clearLongPress()
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true
      setInspectedCard(card)
      setSelectedCard(null)
    }, 420)
  }

  const finishCardPress = (card: (typeof handCards)[number]) => {
    clearLongPress()

    if (didLongPress.current) {
      didLongPress.current = false
      return
    }

    setSelectedCard(card)
  }

  return (
    <article className={`${styles.prototype} ${styles.minimalHud}`}>
      <PrototypeHeader
        label="A"
        title="Minimal Native HUD"
        description="Alles draait om snelle hand-acties en een vaste priority-knop."
      />
      <div className={styles.hudShell}>
        <aside className={styles.slimRail}>
          <PlayerBadge name="Jij" life={18} active />
          <ManaLine />
          <ZoneButton label="Board" value="4" />
          <ZoneButton label="Opp" value="2" />
        </aside>

        <section className={styles.handStage}>
          <div className={styles.phaseBar}>
            <span>Turn 4</span>
            <strong>Main Phase</strong>
            <span>Priority</span>
          </div>
          <div className={styles.handFan}>
            {handCards.map((card, index) => (
              <CardThumb
                key={card.name}
                card={card}
                index={index}
                onPressStart={startCardPress}
                onPressEnd={finishCardPress}
                onPressCancel={clearLongPress}
              />
            ))}
          </div>
        </section>

        <aside className={styles.actionDock}>
          <button className={styles.primaryAction}>Pass Priority</button>
          <button>Open Hand</button>
          <button>View Opponents</button>
          <button>Stack</button>
        </aside>
      </div>

      {selectedCard ? (
        <CardActionModal card={selectedCard} onClose={() => setSelectedCard(null)} />
      ) : null}

      {inspectedCard ? (
        <CardInspectOverlay card={inspectedCard} onClose={() => setInspectedCard(null)} />
      ) : null}
    </article>
  )
}

function CardTable() {
  return (
    <article className={`${styles.prototype} ${styles.cardTable}`}>
      <PrototypeHeader
        label="B"
        title="Card Table Controller"
        description="De controller voelt als een mini-tafel: hand onderin, board centraal, opponents rechts."
      />
      <div className={styles.tableShell}>
        <section className={styles.tableBoard}>
          <div className={styles.tableTop}>
            <PlayerBadge name="Jij" life={18} active />
            <div className={styles.phasePill}>Declare Attackers</div>
            <PlayerBadge name="Nora" life={12} />
          </div>
          <div className={styles.boardRows}>
            <BoardRow title="My Battlefield" cards={boardCards} />
            <BoardRow title="Opponent Battlefield" cards={opponentCards} opponent />
          </div>
          <div className={styles.tableHand}>
            {handCards.map((card, index) => (
              <CardThumb key={card.name} card={card} index={index} flat />
            ))}
          </div>
        </section>

        <aside className={styles.contextPanel}>
          <h3>Selected</h3>
          <SelectedMini />
          <button className={styles.primaryAction}>Confirm Attack</button>
          <button>Tap for Mana</button>
        </aside>
      </div>
    </article>
  )
}

function StackResponder() {
  return (
    <article className={`${styles.prototype} ${styles.stackResponder}`}>
      <PrototypeHeader
        label="C"
        title="Stack Responder"
        description="Priority en stack krijgen de hoofdrol wanneer je moet reageren."
      />
      <div className={styles.stackShell}>
        <section className={styles.stackInbox}>
          <div className={styles.priorityHeader}>
            <span>Priority Inbox</span>
            <strong>2 stack items</strong>
          </div>
          {stackItems.map((item) => (
            <div className={styles.stackItem} key={item.title}>
              <strong>{item.title}</strong>
              <span>{item.owner}</span>
              <small>Target: {item.target}</small>
            </div>
          ))}
        </section>

        <section className={styles.reactionStage}>
          <div className={styles.reactionHand}>
            {handCards
              .filter((card) => card.type === 'Instant')
              .map((card, index) => (
                <CardThumb key={card.name} card={card} index={index} flat />
              ))}
          </div>
          <div className={styles.targetStrip}>
            <BoardRow title="Available Targets" cards={opponentCards.slice(1, 4)} opponent />
          </div>
        </section>

        <aside className={styles.priorityDock}>
          <button className={styles.primaryAction}>Pass Priority</button>
          <button>Cast Response</button>
          <button>View Opponents</button>
        </aside>
      </div>
    </article>
  )
}

function PrototypeHeader({
  label,
  title,
  description,
}: {
  label: string
  title: string
  description: string
}) {
  return (
    <div className={styles.prototypeHeader}>
      <span>{label}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  )
}

function PlayerBadge({ name, life, active = false }: { name: string; life: number; active?: boolean }) {
  return (
    <div className={active ? `${styles.playerBadge} ${styles.activePlayer}` : styles.playerBadge}>
      <span>{name}</span>
      <strong>{life}</strong>
    </div>
  )
}

function ManaLine() {
  return (
    <div className={styles.manaLine}>
      {['W', 'U', 'B', 'R', 'G', 'C'].map((mana, index) => (
        <span key={mana}>{index === 1 || index === 3 ? '1' : mana}</span>
      ))}
    </div>
  )
}

function ZoneButton({ label, value }: { label: string; value: string }) {
  return (
    <button className={styles.zoneButton}>
      <span>{label}</span>
      <strong>{value}</strong>
    </button>
  )
}

function CardThumb({
  card,
  index,
  flat = false,
  onPressStart,
  onPressEnd,
  onPressCancel,
}: {
  card: { name: string; type: string; cost: string }
  index: number
  flat?: boolean
  onPressStart?: (card: { name: string; type: string; cost: string }) => void
  onPressEnd?: (card: { name: string; type: string; cost: string }) => void
  onPressCancel?: () => void
}) {
  return (
    <button
      className={flat ? `${styles.cardThumb} ${styles.flatCard}` : styles.cardThumb}
      style={{ '--card-index': index } as React.CSSProperties}
      onPointerDown={() => onPressStart?.(card)}
      onPointerUp={() => onPressEnd?.(card)}
      onPointerCancel={onPressCancel}
      onPointerLeave={onPressCancel}
    >
      <span>{card.cost || 'LAND'}</span>
      <strong>{card.name}</strong>
      <small>{card.type}</small>
    </button>
  )
}

function CardActionModal({
  card,
  onClose,
}: {
  card: { name: string; type: string; cost: string }
  onClose: () => void
}) {
  return (
    <div className={styles.actionModalBackdrop} onPointerDown={onClose}>
      <div className={styles.actionModal} onPointerDown={(event) => event.stopPropagation()}>
        <div className={styles.modalCardPreview}>
          <span>{card.cost || 'LAND'}</span>
          <strong>{card.name}</strong>
          <small>{card.type}</small>
        </div>
        <div className={styles.modalActions}>
          <span>Card actions</span>
          <h3>{card.name}</h3>
          <button className={styles.primaryAction}>Cast / Play</button>
          <button>Choose Targets</button>
          <button>Pay Mana</button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function CardInspectOverlay({
  card,
  onClose,
}: {
  card: { name: string; type: string; cost: string }
  onClose: () => void
}) {
  return (
    <div className={styles.inspectOverlay} onPointerUp={onClose} onPointerCancel={onClose}>
      <div className={styles.inspectCard}>
        <span>{card.cost || 'LAND'}</span>
        <strong>{card.name}</strong>
        <small>{card.type}</small>
        <p>Full-card inspect preview. Houd ingedrukt om te bekijken, laat los om terug te gaan.</p>
      </div>
    </div>
  )
}

function BoardRow({
  title,
  cards,
  opponent = false,
}: {
  title: string
  cards: Array<{ name: string; tapped: boolean }>
  opponent?: boolean
}) {
  return (
    <div className={styles.boardRow}>
      <span>{title}</span>
      <div>
        {cards.map((card) => (
          <button
            key={card.name}
            className={opponent ? `${styles.boardCard} ${styles.opponentCard}` : styles.boardCard}
            data-tapped={card.tapped}
          >
            {card.name}
          </button>
        ))}
      </div>
    </div>
  )
}

function SelectedMini() {
  return (
    <div className={styles.selectedMini}>
      <span>Selected Card</span>
      <strong>Counterspell</strong>
      <small>Choose stack target, then cast.</small>
    </div>
  )
}
