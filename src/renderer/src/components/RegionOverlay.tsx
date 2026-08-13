import { useEffect, useRef, useState } from 'react'

/**
 * The drag-a-rectangle overlay for region capture.
 *
 * It renders the ALREADY-CAPTURED screen as its background rather than being a
 * transparent hole onto the desktop. Two reasons, both practical: a transparent
 * frameless window under software rendering paints solid black on Windows, and a
 * frozen image means the shot cannot change under the user while they are choosing
 * what to shoot — a notification arriving mid-drag no longer ends up in the crop.
 */
interface Begin {
  image: string
  scaleFactor: number
}

export default function RegionOverlay() {
  const [image, setImage] = useState<string | null>(null)
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [now, setNow] = useState<{ x: number; y: number } | null>(null)
  // Guards against reporting twice: mouseup and a stray keydown can both fire.
  const done = useRef(false)

  const finish = (sel: { x: number; y: number; width: number; height: number } | null): void => {
    if (done.current) return
    done.current = true
    void window.clipmd.invoke('region:result', sel)
  }

  useEffect(() => {
    return window.clipmd.on('region:begin', (p: Begin) => setImage(p.image))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Esc must always work, including before the image has arrived — otherwise a
      // slow capture leaves a full-screen window with no way out.
      if (e.key === 'Escape') finish(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const rect =
    start && now
      ? {
          left: Math.min(start.x, now.x),
          top: Math.min(start.y, now.y),
          width: Math.abs(now.x - start.x),
          height: Math.abs(now.y - start.y)
        }
      : null

  return (
    <div
      className="region-overlay"
      onMouseDown={(e) => {
        // Right-click cancels, the same as Esc — it is what every other snipping
        // tool does, and a user who has started the wrong drag reaches for it.
        if (e.button !== 0) return finish(null)
        setStart({ x: e.clientX, y: e.clientY })
        setNow({ x: e.clientX, y: e.clientY })
      }}
      onMouseMove={(e) => start && setNow({ x: e.clientX, y: e.clientY })}
      onMouseUp={(e) => {
        if (!start) return
        finish({
          x: Math.min(start.x, e.clientX),
          y: Math.min(start.y, e.clientY),
          width: Math.abs(e.clientX - start.x),
          height: Math.abs(e.clientY - start.y)
        })
      }}
    >
      {image && <img className="region-shot" src={image} alt="" draggable={false} />}
      <div className="region-dim" />
      {rect && (
        <>
          {/* The selection is a hole in the dim layer, drawn as a bright cut-out
              rather than a border so the user sees the actual pixels they are
              taking, at full brightness. */}
          <div className="region-sel" style={rect}>
            {image && (
              <img
                className="region-shot"
                src={image}
                alt=""
                draggable={false}
                style={{ marginLeft: -rect.left, marginTop: -rect.top }}
              />
            )}
          </div>
          <div className="region-size" style={{ left: rect.left, top: Math.max(0, rect.top - 24) }}>
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </div>
        </>
      )}
    </div>
  )
}
