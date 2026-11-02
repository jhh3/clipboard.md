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
      ['↵', 'ask (input) / paste (item selected)'],
      ['↓ ↑', 'move between the ask row and history'],
      ['Tab', 'attach the clip to your next ask'],
      [`${MOD}D`, 'voice ask (toggle mic)'],
      [MOD === '⌘' ? '🌐 (hold)' : '⌃⌥Space (hold)', 'dictate into the ask box (review, then ↵)'],
      ['⇧↵', 'paste as plain text'],
      [`${MOD}↵`, 'copy without pasting'],
      [`${MOD}1–9`, 'quick-paste item 1–9'],
      [`${MOD}P`, 'pin / unpin'],
      [`${MOD}⌫`, 'delete item'],
      [`${MOD}F`, 'cycle kind filter'],
      [`${MOD}← →`, 'previous / next filter chip'],
      [`${MOD}⇧S`, 'screenshot to history'],
      ['Esc', 'clear search, then close']
    ]
  ],
  [
    'Anywhere',
    [
      [`${GLOBAL_MOD}V`, 'clipboard palette'],
      [`${GLOBAL_MOD}R`, 'rewrite selection'],
      [`${GLOBAL_MOD}S`, 'screenshot to history'],
      [MOD === '⌘' ? '🌐' : `${GLOBAL_MOD}Space`, 'dictate (hold to talk)']
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
