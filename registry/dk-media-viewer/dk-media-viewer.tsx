'use client'

/* DKMediaViewer — the masonry grid + the lightbox it opens.
 *
 *   <DKMediaViewer items={items} />
 *
 * Items are plain data (see types.ts) — hand-written, CMS-mapped, or generated with
 * `npx dkmediaviewer scan ./public/photos`. Photos render as lazy <img>s (or through your own
 * renderImage slot, e.g. next/image); videos autoplay muted in the grid and hand off
 * frame-accurately to the lightbox player when clicked. */

import { useState, useEffect, useRef } from 'react'
import type { DKMediaItem } from './types'
import { useDKLightbox } from './dk-lightbox'

export interface DKMediaViewerProps {
  items: DKMediaItem[]
  /** Extra classes on the outer grid wrapper. */
  className?: string
  /** A sharper large variant for the lightbox to fade in over the base image (and to prefetch
   *  on hover and around the open item) — e.g. a CDN resize URL. Default: none; the lightbox
   *  shows item.src, which for local files is already the full image. */
  getHiResSrc?: (item: DKMediaItem) => string
  /** Render the grid image yourself (e.g. with next/image). Apply ctx.className to the visible
   *  image element and honor ctx.sizes/ctx.priority; the lightbox still works untouched — it
   *  reads the rendered <img>'s decoded file at click time. */
  renderImage?: (
    item: DKMediaItem,
    ctx: { index: number; priority: boolean; sizes: string; className: string },
  ) => React.ReactNode
  /** The 1px photo edge outline in the lightbox. Default true (photographs). */
  showOutline?: boolean
  /** Reserve the lightbox caption/exif rail. Default: on when any item carries one. */
  hasCaptions?: boolean
  /** Open from `?photo=<index>` on mount, for shareable deep links. Default off. */
  deepLink?: boolean
}

const GRID_SIZES = '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw'
const IMG_CLASS = 'dk-img-outline w-full h-auto transition-opacity duration-200 group-hover:opacity-85'

export function DKMediaViewer({
  items,
  className,
  getHiResSrc,
  renderImage,
  showOutline = true,
  hasCaptions,
  deepLink = false,
}: DKMediaViewerProps) {
  const [numCols, setNumCols] = useState(3)
  const prefetched = useRef<Set<string>>(new Set())
  // Thumbnail registry: close hands focus back to the item the viewer ended on, and deep links
  // need a zoom origin — both resolved through here.
  const thumbEls = useRef<Map<number, HTMLButtonElement>>(new Map())

  const { open, lightbox } = useDKLightbox(items, {
    getHiResSrc,
    showOutline,
    hasCaptions,
    deepLink,
    getOriginEl: (i) => thumbEls.current.get(i) ?? null,
  })

  // Warm the hi-res layer on hover/focus so it is already downloading by the time the lightbox
  // opens — the browser cache hit makes the sharp layer's fade-in instant instead of a re-fetch
  // after the fly-in lands. No-op without getHiResSrc (the lightbox then reuses the grid's file).
  const prefetchHiRes = (item: DKMediaItem) => {
    if (!getHiResSrc) return
    const hi = getHiResSrc(item)
    if (!hi || hi === item.src || prefetched.current.has(hi)) return
    prefetched.current.add(hi)
    const img = new window.Image()
    img.src = hi
  }

  useEffect(() => {
    const sm = window.matchMedia('(max-width: 639px)')
    const md = window.matchMedia('(max-width: 1023px)')

    const update = () => {
      if (sm.matches) setNumCols(1)
      else if (md.matches) setNumCols(2)
      else setNumCols(3)
    }

    update()
    sm.addEventListener('change', update)
    md.addEventListener('change', update)
    return () => {
      sm.removeEventListener('change', update)
      md.removeEventListener('change', update)
    }
  }, [])

  if (items.length === 0) return null

  const columns: Array<Array<{ item: DKMediaItem; originalIndex: number }>> =
    Array.from({ length: numCols }, () => [])
  items.forEach((item, i) => columns[i % numCols].push({ item, originalIndex: i }))

  return (
    <>
      {/* data-dk-scope: the lightbox pauses playing <video>s inside this wrapper while open. */}
      <div data-dk-scope className={`dk-scope flex gap-4${className ? ` ${className}` : ''}`}>
        {columns.map((colItems, colIndex) => (
          <div key={colIndex} className="flex-1 flex flex-col gap-4">
            {colItems.map(({ item, originalIndex }) => (
              <button
                key={item.src}
                ref={(el) => {
                  if (el) thumbEls.current.set(originalIndex, el)
                  else thumbEls.current.delete(originalIndex)
                }}
                onMouseEnter={() => prefetchHiRes(item)}
                onFocus={() => prefetchHiRes(item)}
                onClick={(e) => open(originalIndex, e.currentTarget, e)}
                // No focus-visible override: the host's global :focus-visible styling (or the
                // browser default) gives keyboard users their ring — opting out leaves them
                // tabbing blind.
                className="dk-cv-auto block w-full cursor-zoom-in group"
                aria-label={item.alt ?? item.caption ?? (item.videoSrc ? 'Play video' : 'Open photo')}
              >
                {item.videoSrc ? (
                  // Clips autoplay muted in the grid (poster = item.src covers the load). The
                  // lightbox resumes from this element's exact frame — see useDKLightbox's capture.
                  <video
                    src={item.videoSrc}
                    poster={item.src}
                    muted
                    loop
                    playsInline
                    autoPlay
                    preload="metadata"
                    className={IMG_CLASS}
                    style={
                      item.width && item.height
                        ? { aspectRatio: `${item.width} / ${item.height}` }
                        : undefined
                    }
                  />
                ) : renderImage ? (
                  renderImage(item, {
                    index: originalIndex,
                    priority: originalIndex < 3,
                    sizes: GRID_SIZES,
                    className: IMG_CLASS,
                  })
                ) : (
                  <img
                    src={item.src}
                    alt={item.alt ?? item.caption ?? ''}
                    width={item.width}
                    height={item.height}
                    sizes={GRID_SIZES}
                    className={IMG_CLASS}
                    loading={originalIndex < 3 ? 'eager' : 'lazy'}
                    decoding="async"
                    // Blur-up stand-in: the item's dominant color fills the box until the image
                    // paints, then clears (so transparent images don't keep a colored tile).
                    style={item.color ? { backgroundColor: item.color } : undefined}
                    onLoad={(e) => { e.currentTarget.style.backgroundColor = '' }}
                  />
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
      {lightbox}
    </>
  )
}
