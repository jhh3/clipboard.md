import { GLOBAL_MOD, MOD } from '../lib/keys'

/**
 * Shortcut cheat sheet (⌘/ in the palette). Linear/Superhuman-style overlay: the
 * point is discoverability — every direct shortcut in the app, in one glance,
 * grouped by where it applies. Kept as data so it can't drift into prose.
 */

type Entry = [keys: string, label: string]

const GROUPS: Array<[title: string, entries: Entry[]]> = [
  [
    'Palette',
    [
      ['↵', 'ask assistant (input) / paste (item selected)'],
      ['↓ ↑', 'move between assistant and history'],
      [`${MOD}D`, 'voice ask (toggle mic)'],
      ['⇧↵', 'paste as plain text'],
      [`${MOD}↵`, 'copy without pasting'],
      [`${MOD}1–9`, 'quick-paste item 1–9'],
      ['Tab', 'actions on the selected item'],
      [`${MOD}J`, 'send clip to an agent session'],
      [`${MOD}N`, 'new note from the selected clip'],
      [`${MOD}P`, 'pin / unpin'],
      [`${MOD}⌫`, 'delete item'],
      [`${MOD}F`, 'cycle kind filter'],
      [`${MOD}← →`, 'previous / next filter chip'],
      [`${MOD}E`, 'open in scratchpad'],
      ['Esc', 'clear search, then close']
    ]
  ],
  [
    'Anywhere',
    [
      [`${GLOBAL_MOD}V`, 'clipboard palette'],
      [`${GLOBAL_MOD}R`, 'rewrite selection'],
      [`${GLOBAL_MOD}S`, 'screenshot to history'],
      [`${GLOBAL_MOD}E`, 'scratchpad'],
      [`${GLOBAL_MOD}${MOD === '⌘' ? 'D' : 'Space'}`, 'dictate (hold)'],
      [`${GLOBAL_MOD}N`, 'notes'],
      [`${GLOBAL_MOD}A`, 'agent inbox']
    ]
  ],
  [
    'Notes window',
    [
      [`${MOD}N`, 'new note'],
      [`${MOD}D`, "today's note"],
      [`${MOD}F`, 'filter notes'],
      [`${MOD}-click`, 'follow a [[wikilink]]']
    ]
  ]
]

export default function HelpOverlay({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div className="help-overlay" onClick={onClose}>
      <div className="help-card" onClick={(e) => e.stopPropagation()}>
        <div className="help-head">
          <span>Keyboard shortcuts</span>
          <kbd>esc</kbd>
        </div>
        <div className="help-groups">
          {GROUPS.map(([title, entries]) => (
            <div key={title} className="help-group">
              <h4>{title}</h4>
              {entries.map(([keys, label]) => (
                <div key={keys + label} className="help-row">
                  <kbd>{keys}</kbd>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
