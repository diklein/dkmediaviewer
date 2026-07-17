'use client'

/* DKCarousel — a crossfading slideshow over the same items the grid takes.
 *
 *   <DKCarousel items={items} ratio="3 / 2" />
 *
 * Images are stacked; the outgoing slide animates opacity + a small blur (a "blur-dissolve"),
 * both GPU-composited (safe for photos; the subpixel-AA caveat that bars opacity-animating TEXT
 * does not apply to images). The frame carries a fixed aspect-ratio so it reserves its space and
 * never shifts layout. Auto-advance stops for `prefers-reduced-motion` and while the tab is
 * hidden. Clicking a slide opens the shared lightbox over the whole set — navigable with the
 * same arrows, captions and EXIF included.
 *
 * The fade is one-directional to avoid the crossfade "dip": the incoming slide snaps fully
 * opaque UNDERNEATH, and only the OUTGOING slide fades out on top of it. If both faded at once,
 * the midpoint (both ~50% transparent) would let the page show through and read as a flash. So
 * the outgoing frame carries the transition and the higher z-index; the incoming one just sits
 * there solid, revealed as the old one dissolves away. */

import { useEffect, useRef, useState } from 'react'
import type { DKMediaItem } from './types'
import { useDKLightbox } from './dk-lightbox'

export interface DKCarouselProps {
  items: DKMediaItem[]
  /** The frame's CSS aspect-ratio, e.g. "3 / 2", "16 / 9". */
  ratio?: string
  /** Auto-advance dwell per slide, in ms. */
  interval?: number
  /** Extra classes on the outer wrapper. */
  className?: string
  /** A sharper large variant for the lightbox — see DKMediaViewer. */
  getHiResSrc?: (item: DKMediaItem) => string
  /** The 1px photo edge outline in the lightbox. Default off here — carousels often carry
   *  screenshots and full-bleed art where it reads as a stray border. */
  showOutline?: boolean
}

export function DKCarousel({
  items,
  ratio = '3 / 2',
  interval = 5000,
  className,
  getHiResSrc,
  showOutline = false,
}: DKCarouselProps) {
  const [active, setActive] = useState(0)
  // The slide that should fade OUT: whatever was active before this render's change. A ref
  // updated in an effect holds the previous committed index — during the render where `active`
  // just changed, it still points at the outgoing slide, which is exactly what we want to fade.
  const prevRef = useRef(0)
  useEffect(() => {
    prevRef.current = active
  }, [active])
  const prev = prevRef.current

  const slideEls = useRef<Map<number, HTMLButtonElement>>(new Map())
  const { open, isOpen, lightbox } = useDKLightbox(items, {
    getHiResSrc,
    showOutline,
    getOriginEl: (i) => slideEls.current.get(i) ?? null,
    // Land the carousel on the slide the viewer navigated to in the lightbox, so the close
    // fly-back and the focus restore both target the slide that is actually visible.
    onClose: (i) => setActive(i),
  })

  // The effect depends on `active`, so it re-arms the timeout every advance — which also means
  // a manual jump (a dot click that sets `active`) resets the dwell, keeping the progress pill
  // in sync with the timer. No autoplay for reduced-motion users; the tab-hidden pause avoids
  // a burst of queued advances landing at once on return. Paused while the lightbox is open —
  // the viewer is looking at THIS set enlarged; the deck shouldn't shuffle under them.
  useEffect(() => {
    if (items.length < 2 || isOpen) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      timer = setTimeout(() => setActive((i) => (i + 1) % items.length), interval)
    }
    const onVisibility = () => {
      clearTimeout(timer)
      if (!document.hidden) schedule()
    }
    if (!document.hidden) schedule()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, items.length, interval, isOpen])

  if (items.length === 0) return null

  return (
    <div data-dk-scope className={`dk-scope w-full${className ? ` ${className}` : ''}`}>
      <style>{`
        /* Animate transform, not width: a width animation relayouts the pill every frame (main
           thread) and reads as stepping; scaleX runs on the compositor and stays smooth. */
        @keyframes dk-ss-progress { from { transform: scaleX(0) } to { transform: scaleX(1) } }
        .dk-ss-fill { width: 100%; transform-origin: left; }
        @media (prefers-reduced-motion: no-preference) {
          .dk-ss-fill { transform: scaleX(0); animation: dk-ss-progress var(--dk-ss-dur, 5000ms) linear forwards; }
        }
      `}</style>
      <div className="relative w-full overflow-hidden" style={{ aspectRatio: ratio }}>
        {items.map((item, i) => {
          const isActive = i === active
          // Only the outgoing slide animates (fades to 0) and sits on top; the incoming slide
          // snaps to full opacity beneath it. `prev !== active` guards the first paint, where
          // there is no previous slide.
          const isPrev = i === prev && prev !== active
          return (
            // Each slide opens the shared lightbox — and because every slide is registered, the
            // lightbox gallery is the whole carousel, navigable with the same arrows. Only the
            // active slide is interactive: the stacked inactive slides sit at pointer-events:none
            // (and out of the tab order) so a click can't land on the top-of-stack image instead
            // of the visible one. The crossfade rides the button's opacity.
            <button
              key={item.src}
              type="button"
              ref={(el) => {
                if (el) slideEls.current.set(i, el)
                else slideEls.current.delete(i)
              }}
              onClick={(e) => open(i, e.currentTarget, e)}
              aria-label={item.alt ? `Enlarge: ${item.alt}` : 'View enlarged'}
              aria-hidden={!isActive}
              tabIndex={isActive ? 0 : -1}
              className={`absolute inset-0 block cursor-zoom-in ease-out focus-visible:outline-none${
                isPrev ? ' transition-[opacity,filter] duration-700 motion-reduce:transition-none' : ''
              }`}
              style={{
                opacity: isActive ? 1 : 0,
                // Blur-dissolve: the outgoing slide softens as it leaves, so the departure reads as
                // a cinematic dissolve rather than a flat opacity ramp. The incoming slide stays
                // sharp and solid beneath (see the one-way fade note above), so there's no dip.
                filter: isPrev ? 'blur(6px)' : 'none',
                // Outgoing on top (it does the fading); incoming just beneath, solid; rest behind.
                zIndex: isPrev ? 20 : isActive ? 10 : 0,
                pointerEvents: isActive ? 'auto' : 'none',
              }}
            >
              <img
                src={item.src}
                alt={item.alt ?? ''}
                className="absolute inset-0 h-full w-full object-cover"
                decoding="async"
                draggable={false}
              />
            </button>
          )
        })}

        {items.length > 1 && (
          // bottom-0: dots centred in a 24px hit area (8px padding) land the dot 8px above the base.
          // z-30 keeps the dots above the slides, which carry z-index (10/20) for the one-way fade.
          <div className="absolute inset-x-0 bottom-0 z-30 flex items-center justify-center gap-1">
            {items.map((item, i) => {
              const isActive = i === active
              return (
                <button
                  key={item.src}
                  type="button"
                  aria-label={`Show ${item.alt ?? `slide ${i + 1}`}`}
                  aria-current={isActive}
                  onClick={() => setActive(i)}
                  // The dot stays small, but the button is a taller/padded hit target so it is
                  // easy to click, with a pointer cursor and a hover brighten so it reads as one.
                  className="group/dot flex h-6 cursor-pointer items-center px-0.5"
                >
                  <span
                    className="relative block h-2 overflow-hidden rounded-full transition-[width,filter] duration-300 ease-out group-hover/dot:brightness-150"
                    style={{
                      width: isActive ? 30 : 8,
                      backgroundColor: isActive ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.55)',
                    }}
                  >
                    {/* The active pill's fill sweeps over the dwell time. Keyed by `active` so
                        React remounts it each advance, restarting the CSS animation from 0. */}
                    {isActive && (
                      <span
                        key={active}
                        className="dk-ss-fill absolute inset-y-0 left-0 rounded-full bg-white"
                        style={{ ['--dk-ss-dur' as string]: `${interval}ms` }}
                      />
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
      {items[active].caption && (
        <p className="mt-3 text-center font-[family-name:var(--dk-font-sans)] text-[0.95rem] leading-snug text-[var(--dk-muted)]">
          {items[active].caption}
        </p>
      )}
      {lightbox}
    </div>
  )
}
