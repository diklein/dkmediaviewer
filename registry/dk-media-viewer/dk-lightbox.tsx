'use client'

/* DKLightbox — the fly-in modal viewer, plus useDKLightbox(), the controller hook the grid and
 * the carousel open it through.
 *
 * One long movement: the photo flies from its place on the page on the house spring, arriving
 * a touch large and settling, while the backdrop finishes first, the controls are simply
 * present, and the sharper file (getHiResSrc) fades up inside the flight. The caption is a
 * line of ink under the photo. Closing flies the photo back to where it came from.
 *
 * Left and right move the items as one track on the same spring. Touch is two phases: while
 * the finger is down the photo IS the finger (transforms written straight to the elements, no
 * easing, no React state); when it lifts, the spring finishes the move, seeded with the speed
 * the finger left at. A release commits on distance OR velocity, a slide in flight can be
 * caught, and the backdrop on a pull-down is derived from the same samples as the photo.
 *
 * Everything animates through the Web Animations API: no animation library, and transforms
 * and opacities stay on the compositor, so a main-thread hitch cannot land in the picture. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { formatExif, type DKMediaItem } from './types'

const FLIGHT = 550 // the open flight, ms
const BACKDROP = 300 // the backdrop's fade, finished before the photo lands
const BACK = 344 // the return flight
const SHARPEN_AT = 0.66 // the fraction of the flight after which the sharp file may fade up
const SHARPEN = 300
const EDGE = 16 // the photo's inset from the viewport edges
const SLOW = 6 // Shift-click / Shift-arrow stretch, for frame-by-frame inspection
const CLOSE_DRAG = 100 // pull the photo down past this (px) to dismiss
const REVEAL = 280 // the pull distance over which the page comes fully back into view
const FLICK = 500 // px/s: a release this fast commits on its own, however short the drag
/* The veil never goes below this while mounted: at exactly 0 an element paints nothing and
 * Safari tears its layers down, and rebuilding them is the lazy path that pops instead of fading. */
const VEIL_MIN = 0.002
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)'
const EASE_EXIT = 'cubic-bezier(0.4, 0, 1, 1)'
const revealAt = (pull: number) => 1 - Math.min(1, Math.max(0, pull) / REVEAL)

/* THE HOUSE SPRING: stiffness 620, damping 36, mass 0.7 (ζ ≈ 0.86, ωₙ ≈ 30). About half a
 * percent of overshoot: present, not gratuitous. It appears here twice. The open flight plays
 * its unit step stretched over FLIGHT. Every release (a page, a snap back) solves
 * it in closed form from where the thing is, with the velocity the finger let go at, so a
 * flick is thrown and a slow drag settles, and each lands differently, as real things do. */
const SPRING_W = Math.sqrt(620 / 0.7)
const SPRING_Z = 36 / (2 * Math.sqrt(620 * 0.7))
const SPRING_WD = SPRING_W * Math.sqrt(1 - SPRING_Z * SPRING_Z)
function springSamples(from: number, to: number, v0: number): { xs: number[]; ms: number } {
  const a = from - to
  const b = (v0 + SPRING_Z * SPRING_W * a) / SPRING_WD
  // Long enough for the envelope to fall under a quarter pixel, within sane bounds.
  const secs = Math.min(0.9, Math.max(0.12, Math.log(Math.max(Math.abs(a), Math.abs(b), 1) / 0.25) / (SPRING_Z * SPRING_W)))
  const n = Math.ceil(secs * 60)
  const xs: number[] = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * secs
    xs.push(to + Math.exp(-SPRING_Z * SPRING_W * t) * (a * Math.cos(SPRING_WD * t) + b * Math.sin(SPRING_WD * t)))
  }
  xs.push(to)
  return { xs, ms: secs * 1000 }
}
/* The spring's unit step, sampled so it reaches rest at t=1. The flight plays these as one
 * keyframe per sample on a linear clock, NOT as a linear() easing over two keyframes: Safari
 * cannot hand a linear() curve to its compositor and runs such a flight on the main thread,
 * where every hiccup of the open (the sharp file arriving, a render, a content blocker) is a
 * dropped frame in the photo's movement. Sampled keyframes stay on the compositor. */
const FLIGHT_STEPS = (() => {
  const points = 48
  const omega = 6.9 / SPRING_Z
  const wd = omega * Math.sqrt(1 - SPRING_Z * SPRING_Z)
  const xs: number[] = []
  for (let i = 0; i < points; i++) {
    const t = i / points
    xs.push(1 - Math.exp(-SPRING_Z * omega * t) * (Math.cos(wd * t) + (SPRING_Z / Math.sqrt(1 - SPRING_Z * SPRING_Z)) * Math.sin(wd * t)))
  }
  xs.push(1)
  return xs
})()

interface Rect { left: number; top: number; width: number; height: number }
interface Gesture {
  x: number; y: number
  axis: 'x' | 'y' | null
  /** Where the axis locked: movement is measured from here, so nothing jumps to the finger. */
  lx: number; ly: number
  /** The track's own offset when the finger landed (non-zero when a slide was caught). */
  base: number
  ox: number; oy: number
  ghostBase: Map<HTMLElement, number>
  trail: { t: number; x: number; y: number }[]
}
/** One item as the lightbox shows it: the public item plus what the page knows right now. */
interface View {
  index: number
  item: DKMediaItem
  /** The file the page element has already decoded (its currentSrc), else item.src. */
  src: string
  /** The sharper file to fade up over it, when there is one. */
  hi: string | null
  width: number
  height: number
}
/** What the opener captured at click time. */
export interface DKLightboxStart {
  index: number
  /** The clicked element's on-screen rect, the flight's origin. Null opens in place. */
  rect: Rect | null
  /** Shift-click: stretch the whole open for frame-by-frame inspection. */
  slow: boolean
  /** A clicked clip's playhead, so the modal player resumes from the same frame. */
  videoTime?: number
  /** A snapshot of the exact clicked video frame, painted while the player seeks. */
  poster?: string
}

const contain = (w: number, h: number, box: Rect): Rect => {
  const ar = w / h
  let iw = box.width, ih = box.width / ar
  if (ih > box.height) { ih = box.height; iw = box.height * ar }
  return { left: box.left + (box.width - iw) / 2, top: box.top + (box.height - ih) / 2, width: iw, height: ih }
}
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const xOf = (n: Element) => new DOMMatrix(getComputedStyle(n).transform).m41
const place = (box: HTMLElement, r: Rect) => {
  box.style.left = `${r.left}px`; box.style.top = `${r.top}px`
  box.style.width = `${r.width}px`; box.style.height = `${r.height}px`
}
const shiftX = (el: HTMLElement, x: number) => { el.style.transform = `translateX(${x}px)` }
/** The on-page media of an origin element: its <img> or <video>, else the element itself. */
const mediaOf = (el: HTMLElement) => el.querySelector<HTMLElement>('img, video') ?? el
const rectOf = (el: HTMLElement): Rect => {
  const r = mediaOf(el).getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}
/* The photo at its resting rect, dressed as the page element it flies from (or back to). A
 * uniform scale, never a stretch: the photo covers the element's rect and a clip-path trims
 * what the element crops (a carousel slide is object-cover; a grid thumbnail crops nothing,
 * so its inset is zero and this is a plain translate + scale). */
const dressOf = (el: Rect, rest: Rect) => {
  const k = Math.max(el.width / rest.width, el.height / rest.height)
  return {
    k,
    tx: el.left + el.width / 2 - (rest.width * k) / 2 - rest.left,
    ty: el.top + el.height / 2 - (rest.height * k) / 2 - rest.top,
    cx: Math.max(0, (rest.width * k - el.width) / 2 / k),
    cy: Math.max(0, (rest.height * k - el.height) / 2 / k),
  }
}
const dressAs = (el: Rect, rest: Rect) => {
  const d = dressOf(el, rest)
  return { transform: `translate(${d.tx}px, ${d.ty}px) scale(${d.k})`, clipPath: `inset(${d.cy}px ${d.cx}px)` }
}
/* The open flight from a page element to rest, one keyframe per spring sample. The transform
 * and the trim travel as two animations on the same samples: a clip-path cannot be composited,
 * and sharing an animation with it would pull the transform off the compositor too. A grid
 * thumbnail crops nothing, so it flies on the transform alone. */
const flightFrames = (el: Rect, rest: Rect): { move: Keyframe[]; trim: Keyframe[] | null } => {
  const d = dressOf(el, rest)
  const move = FLIGHT_STEPS.map((p) => ({ transform: `translate(${(d.tx * (1 - p)).toFixed(2)}px, ${(d.ty * (1 - p)).toFixed(2)}px) scale(${(1 + (d.k - 1) * (1 - p)).toFixed(5)})` }))
  const trim = d.cx > 0.5 || d.cy > 0.5
    ? FLIGHT_STEPS.map((p) => ({ clipPath: `inset(${(d.cy * (1 - p)).toFixed(2)}px ${(d.cx * (1 - p)).toFixed(2)}px)` }))
    : null
  return { move, trim }
}
const AT_REST = { transform: 'none', clipPath: 'inset(0px 0px)' }
// A computed colour can come back in any colour space (lab(), oklch()), which a toolbar's
// theme-color parser may not read. One painted pixel gives the plain sRGB triple.
const toRgb = (color: string) => {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return color
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `rgb(${r}, ${g}, ${b})`
}

function viewOf(
  items: DKMediaItem[],
  index: number,
  getOriginEl?: (index: number) => HTMLElement | null,
  getHiResSrc?: (item: DKMediaItem) => string,
  fallback?: Rect | null,
): View | null {
  const item = items[index]
  if (!item) return null
  const el = getOriginEl?.(index) ?? null
  const img = el?.querySelector('img') ?? null
  const video = el?.querySelector('video') ?? null
  // Dimensions: the item's own, else what the page element can tell us, else the clicked rect,
  // else a plain 3:2. Only the ratio matters.
  let width = item.width ?? 0, height = item.height ?? 0
  if (!width || !height) { width = img?.naturalWidth || video?.videoWidth || 0; height = img?.naturalHeight || video?.videoHeight || 0 }
  if ((!width || !height) && fallback) { width = fallback.width; height = fallback.height }
  if (!width || !height) { width = 3; height = 2 }
  const hi = item.videoSrc ? null : getHiResSrc?.(item) || null
  return { index, item, src: img?.currentSrc || item.src, hi: hi && hi !== item.src ? hi : null, width, height }
}

const ICON = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const
const IconClose = () => <svg width="24" height="24" viewBox="0 0 24 24" {...ICON}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
const IconPrev = () => <svg width="28" height="28" viewBox="0 0 24 24" {...ICON}><path d="m15 18-6-6 6-6" /></svg>
const IconNext = () => <svg width="28" height="28" viewBox="0 0 24 24" {...ICON}><path d="m9 18 6-6-6-6" /></svg>

/** A clip playing in the lightbox. It stays invisible until it has PAINTED the frame it was
 *  asked to start from: a fresh <video> paints frame 0 before its seek lands, and showing that
 *  would cut to the start of the clip and back. The poster (or the clicked frame's snapshot)
 *  is underneath the whole time, so nothing is ever a hole. A 2px progress bar rides the
 *  bottom edge. Reduced motion: the clip waits, paused, with its native controls. */
function Clip({ src, time }: { src: string; time: number }) {
  const ref = useRef<HTMLVideoElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  const [still] = useState(reduced)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    type Framed = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
    const onFrame = (v as Framed).requestVideoFrameCallback?.bind(v)
    let started = false
    const show = () => setShown(true)
    const onSeeked = () => { if (onFrame) onFrame(show); else show() }
    const start = () => {
      if (started) return
      started = true
      if (time > 0) v.currentTime = time
      else onSeeked()
      if (!still) v.play().catch(() => {})
    }
    v.addEventListener('seeked', onSeeked)
    v.addEventListener('loadedmetadata', start)
    if (v.readyState >= 1) start()
    let raf = 0
    const tick = () => {
      if (barRef.current && v.duration) barRef.current.style.transform = `scaleX(${v.currentTime / v.duration})`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); v.removeEventListener('seeked', onSeeked); v.removeEventListener('loadedmetadata', start) }
  }, [still, time])
  return (
    <>
      <video ref={ref} src={src} muted loop playsInline preload="auto" controls={still} className="absolute inset-0 h-full w-full object-cover" style={{ opacity: shown ? 1 : 0 }} />
      <div data-dk-progress aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px]">
        <div ref={barRef} className="h-full w-full origin-left" style={{ background: 'var(--dk-accent)', transform: 'scaleX(0)' }} />
      </div>
    </>
  )
}

export interface DKLightboxProps {
  items: DKMediaItem[]
  /** What the opener captured at click time (see useDKLightbox's open). */
  start: DKLightboxStart
  /** The on-page element for an item: the flight's origin and destination. */
  getOriginEl?: (index: number) => HTMLElement | null
  /** A sharper large variant to fade up over the base image. */
  getHiResSrc?: (item: DKMediaItem) => string
  /** Show the caption / EXIF line under the photo. */
  hasCaptions?: boolean
  /** A 1px edge outline on the photo. Default off. */
  showOutline?: boolean
  /** Left/right committed a new item. */
  onNavigate?: (index: number) => void
  /** The close has begun (the photo is about to fly back to this item's element). */
  onLeaving?: (index: number) => void
  /** The close has finished; unmount. */
  onClose: (index: number) => void
}

export function DKLightbox({ items, start, getOriginEl, getHiResSrc, hasCaptions = true, showOutline = false, onNavigate, onLeaving, onClose }: DKLightboxProps) {
  const [view, setView] = useState<View | null>(() => viewOf(items, start.index, getOriginEl, getHiResSrc, start.rect))
  // False until the first left/right. From then on the box holds an item that did not fly in,
  // so its sharp layer fades up on decode instead of on the flight's clock.
  const [navigated, setNavigated] = useState(false)
  // The items being left, each a clone of the box riding the track out, and a drag's side
  // previews. Imperative DOM on purpose: they exist for one gesture and are gone.
  const ghosts = useRef<HTMLElement[]>([])
  const sides = useRef<{ el: HTMLElement; delta: number }[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const chromeRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLImageElement>(null)
  const hiRef = useRef<HTMLImageElement>(null)
  const veilRef = useRef<HTMLDivElement | null>(null)
  const veilRaf = useRef(0)
  const flightRef = useRef<Animation | null>(null)
  const navRef = useRef<Animation | null>(null)
  const closing = useRef(false)
  const landed = useRef(false)
  const touch = useRef<Gesture | null>(null)
  const slow = start.slow ? SLOW : 1
  const index = view?.index ?? start.index

  // The photo's resting rect: inset from the viewport edges, above the dock.
  const restRect = useCallback((v: View): Rect => {
    const dockH = dockRef.current?.offsetHeight ?? 0
    return contain(v.width, v.height, { left: EDGE, top: EDGE, width: innerWidth - EDGE * 2, height: innerHeight - EDGE - Math.max(dockH, EDGE) })
  }, [])

  // The close button wears the dark glass circle when the photo runs under it (ink on a dark
  // photo vanishes). Geometry from the photo's RESTING rect, so the verdict is right from the
  // first frame of the flight. Written as an attribute: it is paint, not state.
  const fitChrome = useCallback((v: View) => {
    const btn = closeRef.current
    if (!btn) return
    const r = restRect(v), b = btn.getBoundingClientRect()
    btn.toggleAttribute('data-on-photo', r.top < b.bottom - 8 && r.top + r.height > b.top + 8 && r.left < b.right - 8 && r.left + r.width > b.left + 8)
  }, [restRect])

  const setVeil = (v: number) => { if (veilRef.current) veilRef.current.style.opacity = String(Math.max(VEIL_MIN, v)) }

  // The open: everything starts in the same layout pass, before the first paint.
  useLayoutEffect(() => {
    const root = rootRef.current, box = boxRef.current, backdrop = backdropRef.current, chrome = chromeRef.current, base = baseRef.current
    if (!root || !box || !backdrop || !chrome || !base || !view) return
    const rm = reduced()

    // Scroll lock. The lightbox has no scrollbar and reserves no gutter for one: it spans the
    // physical viewport (window.innerWidth, which 100vw and right:0 both stop short of when
    // the page reserves a classic scrollbar's gutter) and centres on that full width.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const fit = () => { root.style.width = `${innerWidth}px` }
    fit()

    /* The browser's own chrome must take the modal's colour, three ways. Chrome/Android and
       older Safari tint the toolbar from <meta name="theme-color">; a host's own metas (often
       a prefers-color-scheme pair) can out-rank an override, so they are swapped for one
       pinned meta while open. Safari 26 ignores that meta and samples the <html>/<body>
       background instead, so both are pinned too. And Safari's translucent bar blurs the
       DOCUMENT under a fixed overlay, hence the veil: the backdrop's in-document twin,
       absolutely positioned over the viewport and under the modal. It is written from the
       main thread (the bar samples the main-thread paint, where a composited fade reads as a
       cut), follows the pull-down reveal, and never drops to 0, so its layer is never torn
       down mid-session. All three use the resolved colour: html, body and the meta sit
       outside .dk-scope, where the --dk-bg variable does not reach. */
    const bg = toRgb(getComputedStyle(backdrop).backgroundColor)
    const savedMeta = Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    savedMeta.forEach((el) => el.remove())
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    meta.content = bg
    document.head.appendChild(meta)
    const html = document.documentElement
    const prevBodyBg = document.body.style.backgroundColor, prevHtmlBg = html.style.backgroundColor
    document.body.style.backgroundColor = bg
    html.style.backgroundColor = bg
    const veil = document.createElement('div')
    veil.setAttribute('aria-hidden', 'true')
    const fitVeil = () => { veil.style.top = `${window.scrollY - 200}px`; veil.style.height = `${innerHeight + 400}px` }
    Object.assign(veil.style, { position: 'absolute', left: '0', right: '0', zIndex: '49', pointerEvents: 'none', backgroundColor: bg, opacity: String(VEIL_MIN) })
    fitVeil()
    document.body.appendChild(veil)
    veilRef.current = veil
    const onResize = () => { fit(); fitVeil() }
    window.addEventListener('resize', onResize)

    const rest = restRect(view)
    place(box, rest)
    fitChrome(view)
    // Opened without an origin (no element to fly from): the photo simply fades up in place.
    const from = start.rect ? dressAs(start.rect, rest) : null
    const frames = start.rect ? flightFrames(start.rect, rest) : null
    if (from) { box.style.transform = from.transform; if (frames?.trim) box.style.clipPath = from.clipPath }
    else box.style.opacity = '0'
    // The close button's glass waits for the landing: a backdrop blur over a moving layer is
    // recomputed on every frame of the flight, and Safari drops frames doing it. In flight
    // the circle is its flat tint (dk-media-viewer.css, [data-flying]).
    root.setAttribute('data-flying', '')
    const flightMs = rm ? 0 : FLIGHT * slow
    const backdropMs = rm ? 150 : BACKDROP * slow

    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: backdropMs, easing: EASE_OUT, fill: 'both' })
    chrome.style.opacity = '1'
    // The veil rises with the backdrop, on the main thread (see above).
    const t0 = performance.now()
    const rise = (now: number) => {
      const t = Math.min(1, (now - t0) / backdropMs)
      veil.style.opacity = String(Math.max(VEIL_MIN, 1 - (1 - t) ** 2))
      if (t < 1) veilRaf.current = requestAnimationFrame(rise)
    }
    veilRaf.current = requestAnimationFrame(rise)

    let cancelled = false
    const origin = getOriginEl?.(start.index) ?? null
    const fly = () => {
      if (cancelled) return
      // The origin leaves on the frame its copy is painted, never before.
      if (from) requestAnimationFrame(() => { if (origin) origin.style.visibility = 'hidden' })
      // The flight alone rides the spring. Its overshoot belongs to the thing that was
      // launched: fades and the return flight stay on the calm ease.
      const a = frames
        ? box.animate(frames.move, { duration: flightMs, easing: 'linear', fill: 'both' })
        : box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: backdropMs, easing: EASE_OUT, fill: 'both' })
      if (frames?.trim) box.animate(frames.trim, { duration: flightMs, easing: 'linear', fill: 'both' })
      flightRef.current = a
      a.finished.then(() => {
        if (cancelled) return
        root.removeAttribute('data-flying')
        landed.current = true
        if (origin) origin.style.visibility = '' // covered by the modal; back in place for the return
      }).catch(() => {})
      // The sharpen happens inside the flight: once the sharp file is decoded, and not before
      // the chosen fraction of the travel, it fades up over the still-moving photo.
      const hi = hiRef.current
      if (!hi) return
      const f0 = performance.now()
      hi.decode().catch(() => {}).then(() => {
        if (cancelled) return
        window.setTimeout(() => {
          if (cancelled) return
          hi.animate([{ opacity: 0 }, { opacity: 1 }], { duration: rm ? 0 : SHARPEN * slow, easing: EASE_OUT, fill: 'both' })
        }, Math.max(0, flightMs * SHARPEN_AT - (performance.now() - f0)))
      })
    }
    // The copy is the page element's own decoded file, so this resolves at once; the cap only
    // guards a cold cache, where the element itself would still be loading.
    Promise.race([base.decode().catch(() => {}), new Promise((r) => setTimeout(r, 120))]).then(fly)

    return () => {
      cancelled = true
      cancelAnimationFrame(veilRaf.current)
      window.removeEventListener('resize', onResize)
      document.body.style.overflow = prevOverflow
      document.body.style.backgroundColor = prevBodyBg
      html.style.backgroundColor = prevHtmlBg
      meta.remove()
      savedMeta.forEach((el) => document.head.appendChild(el))
      if (origin) origin.style.visibility = ''
      veil.remove()
      veilRef.current = null
      // Any straggler blur Safari's bar still holds after teardown: two frames on (after the
      // opener's exact scroll restore), move the page 1px and put it back. The bar's backdrop
      // provably tracks scroll.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const sy = window.scrollY
        window.scrollTo(window.scrollX, sy > 0 ? sy - 1 : sy + 1)
        requestAnimationFrame(() => window.scrollTo(window.scrollX, sy))
      }))
    }
    // Runs once per open: the lightbox is keyed by its start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A true modal for the keyboard, not just the eye: `inert` on every other <body> child makes
  // the browser enforce the boundary (unfocusable, unclickable, hidden from assistive tech),
  // so Tab cycles the dialog's own controls. Focus moves onto the dialog on open; the opener
  // hands it back to the item's element on close.
  useEffect(() => {
    const root = rootRef.current
    const touched: HTMLElement[] = []
    for (const el of Array.from(document.body.children)) {
      if (el === root || !(el instanceof HTMLElement) || el.inert) continue
      el.inert = true
      touched.push(el)
    }
    root?.focus({ preventScroll: true })
    return () => touched.forEach((el) => { el.inert = false })
  }, [])

  const dropExtras = () => {
    ghosts.current.forEach((el) => el.remove())
    ghosts.current = []
    sides.current.forEach((x) => x.el.remove())
    sides.current = []
  }

  const close = useCallback(() => {
    if (closing.current) return
    closing.current = true
    const box = boxRef.current, backdrop = backdropRef.current, chrome = chromeRef.current
    if (!box || !backdrop || !chrome || !view) return onClose(index)
    // The opener hears first: a carousel turns to this item's slide, so the photo flies back
    // to something that is actually there.
    onLeaving?.(view.index)
    const rm = reduced()
    const ms = rm ? 0 : BACK * slow
    const origin = getOriginEl?.(view.index) ?? null
    const tr = origin ? rectOf(origin) : null
    const onScreen = tr && tr.width > 0 && tr.top + tr.height > 0 && tr.top < innerHeight
    // Leave from wherever things are this frame: mid-flight, mid-slide, or pulled down.
    rootRef.current?.setAttribute('data-flying', '') // the return flight: no live blur either
    const cs = getComputedStyle(box)
    const cur = { transform: cs.transform, clipPath: cs.clipPath === 'none' ? AT_REST.clipPath : cs.clipPath }
    const dim = getComputedStyle(backdrop).opacity
    const chromeDim = getComputedStyle(chrome).opacity
    // The page shows through the fading backdrop now, so the veil steps aside at once.
    cancelAnimationFrame(veilRaf.current)
    setVeil(0)
    ghosts.current.forEach((el) => el.remove())
    ghosts.current = []
    sides.current.forEach((x) => x.el.remove())
    sides.current = []
    box.getAnimations().forEach((a) => a.cancel())
    box.style.transform = ''
    box.style.clipPath = ''
    box.style.opacity = ''
    const rest = restRect(view)
    place(box, rest)
    const anims: Animation[] = []
    if (onScreen && tr) anims.push(box.animate([cur, dressAs(tr, rest)], { duration: ms, easing: EASE_OUT, fill: 'both' }))
    else anims.push(box.animate([{ ...cur, opacity: 1 }, { ...cur, opacity: 0 }], { duration: ms, easing: EASE_OUT, fill: 'both' }))
    anims.push(backdrop.animate([{ opacity: dim }, { opacity: 0 }], { duration: ms, easing: EASE_OUT, fill: 'both' }))
    anims.push(chrome.animate([{ opacity: chromeDim }, { opacity: 0 }], { duration: rm ? 0 : Math.min(ms, 150 * slow), easing: EASE_EXIT, fill: 'both' }))
    Promise.all(anims.map((a) => a.finished)).catch(() => {}).then(() => onClose(view.index))
  }, [getOriginEl, index, onClose, onLeaving, restRect, slow, view])

  /* Prev / next: the items travel as one track, a viewport width per step. There is one live
     box, so the item being left is carried by a clone of it (a ghost). Every piece is handed
     the SAME sampled spring from where it is this frame, so the track stays rigid through an
     interrupt, a reversal or a release mid-drag, and nothing snaps. Returns whether it moved. */
  const go = useCallback((delta: 1 | -1, v0 = 0, slowNav = false): boolean => {
    const box = boxRef.current, root = rootRef.current, flight = flightRef.current
    if (!view || !box || !root || !flight || closing.current) return false
    const next = viewOf(items, view.index + delta, getOriginEl, getHiResSrc)
    if (!next) return false
    // Pressed before the open landed: land it now, so what slides is the photo at rest.
    // (Only while it runs: finish() on an animation already cancelled would revive its fill.)
    if (flight.playState === 'running') flight.finish()
    const x = xOf(box) // 0 at rest, the slide's position mid-slide, the finger's offset after a drag
    const from = x + delta * innerWidth
    const spring = springSamples(from, 0, v0)
    const ms = reduced() ? 0 : spring.ms * (slowNav ? SLOW : slow)
    const ride = (n: HTMLElement, offset: number) => {
      n.getAnimations().forEach((a) => a.cancel())
      return n.animate(spring.xs.map((v) => ({ transform: `translateX(${(v + offset).toFixed(2)}px)` })), { duration: ms, easing: 'linear', fill: 'both' })
    }

    // The item being left, as it looks this frame. A clone does not carry animations, so the
    // sharp layer's opacity is written onto the copy; and a cloned <video> would start over,
    // so a clip leaves as a still of the frame it was on.
    const ghost = box.cloneNode(true) as HTMLDivElement
    ghost.setAttribute('aria-hidden', 'true')
    const ghostHi = ghost.querySelector<HTMLElement>('[data-dk-hi]')
    if (ghostHi && hiRef.current) ghostHi.style.opacity = getComputedStyle(hiRef.current).opacity
    const liveVideo = box.querySelector('video')
    ghost.querySelectorAll('video, [data-dk-progress]').forEach((n) => n.remove())
    if (liveVideo && liveVideo.videoWidth) {
      const still = document.createElement('canvas')
      still.width = liveVideo.videoWidth
      still.height = liveVideo.videoHeight
      still.className = 'absolute inset-0 h-full w-full'
      still.getContext('2d')?.drawImage(liveVideo, 0, 0)
      ghost.appendChild(still)
    }
    // Each piece keeps its distance from the box: read before anything moves.
    const offsets = new Map<HTMLElement, number>(ghosts.current.map((g) => [g, xOf(g) - from]))
    offsets.set(ghost, x - from)
    root.insertBefore(ghost, box)
    const track = [...ghosts.current, ghost]
    ghosts.current = track
    for (const g of track) {
      ride(g, offsets.get(g) ?? 0).finished.then(() => {
        g.remove()
        ghosts.current = ghosts.current.filter((o) => o !== g)
      }).catch(() => {})
    }

    // The neighbour takes the box in the same task, one viewport along, and springs home. A
    // drag's side previews sit exactly there, so the box replaces them without a seam.
    sides.current.forEach((sd) => sd.el.remove())
    sides.current = []
    box.style.transform = ''
    box.style.clipPath = ''
    box.style.opacity = ''
    flushSync(() => { setNavigated(true); setView(next) })
    place(box, restRect(next))
    fitChrome(next)
    navRef.current = ride(box, 0)
    onNavigate?.(next.index)
    return true
  }, [fitChrome, getHiResSrc, getOriginEl, items, onNavigate, restRect, slow, view])

  // An item reached by sliding sharpens when its sharp file is decoded. Its neighbours' files
  // are fetched ahead (next first, then the one after, then the previous: the direction
  // people page in), so that is normally before the slide has landed.
  useLayoutEffect(() => {
    if (!navigated) return
    const hi = hiRef.current
    if (!hi) return
    let off = false
    hi.decode().catch(() => {}).then(() => {
      if (!off) hi.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced() ? 0 : SHARPEN, easing: 'ease-out', fill: 'both' })
    })
    return () => { off = true }
  }, [navigated, index])
  useEffect(() => {
    if (!getHiResSrc) return
    for (const d of [1, 2, -1]) {
      const item = items[index + d]
      if (!item || item.videoSrc) continue
      const hi = getHiResSrc(item)
      if (hi && hi !== item.src) new window.Image().src = hi
    }
    // Keyed to the item on screen; the item list and the resolver are stable enough per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return }
      // Modified chords belong to the browser (Alt+Left is Back, Cmd+Left is Home): only a bare
      // arrow, or Shift+arrow for the slow-motion look, pages items.
      if (e.altKey || e.metaKey || e.ctrlKey) return
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1, 0, e.shiftKey) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1, 0, e.shiftKey) }
    }
    const onResize = () => {
      const box = boxRef.current
      if (!view) return
      if (box && landed.current) place(box, restRect(view))
      fitChrome(view)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize) }
  }, [close, fitChrome, go, restRect, view])

  /* Touch. The axis locks after 8px. Sideways pages between items with the neighbours riding
     along (rubber-banding where there is none); downward pulls the photo away and brings the
     page back in step. The 8px that recognised the gesture is not drag, so the photo starts
     from under the finger. A finger landing on a slide in flight freezes the whole track
     where it is and takes over from there. */
  const mountSides = (root: HTMLElement, box: HTMLElement, at: number) => {
    if (!view) return
    for (const delta of [-1, 1]) {
      const v = viewOf(items, view.index + delta, getOriginEl, getHiResSrc)
      if (!v) continue
      const side = document.createElement('div')
      side.setAttribute('aria-hidden', 'true')
      side.className = 'absolute overflow-hidden'
      if (v.item.color) side.style.backgroundColor = v.item.color
      for (const src of v.hi ? [v.src, v.hi] : [v.src]) {
        const img = document.createElement('img')
        img.src = src; img.alt = ''; img.draggable = false
        img.className = 'absolute inset-0 h-full w-full object-cover'
        side.appendChild(img)
      }
      place(side, restRect(v))
      shiftX(side, delta * innerWidth + at)
      root.insertBefore(side, box)
      sides.current.push({ el: side, delta })
    }
  }
  const onTouchStart = (e: React.TouchEvent) => {
    touch.current = null
    const box = boxRef.current, root = rootRef.current
    if (!box || !root || closing.current || e.touches.length !== 1 || !flightRef.current) return
    if ((e.target as Element).closest('button, a, video[controls]')) return
    const t = e.touches[0]
    const g: Gesture = { x: t.clientX, y: t.clientY, axis: null, lx: 0, ly: 0, base: 0, ox: 0, oy: 0, ghostBase: new Map(), trail: [{ t: e.timeStamp, x: t.clientX, y: t.clientY }] }
    // Caught mid-slide: freeze every piece of the track where it is this frame. The gesture
    // is sideways by definition, and it starts from the track's position, not from zero.
    if (navRef.current?.playState === 'running') {
      g.axis = 'x'
      g.base = xOf(box)
      for (const el of ghosts.current) g.ghostBase.set(el, xOf(el))
      for (const el of [box, ...ghosts.current]) el.getAnimations().forEach((a) => a.cancel())
      shiftX(box, g.base)
      g.ghostBase.forEach((gx, el) => shiftX(el, gx))
      mountSides(root, box, g.base)
    }
    touch.current = g
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const g = touch.current
    const box = boxRef.current, root = rootRef.current, backdrop = backdropRef.current, chrome = chromeRef.current
    if (!g || !box || !root || !backdrop || !chrome) return
    const t = e.touches[0]
    const dx = t.clientX - g.x
    const dy = t.clientY - g.y
    g.trail.push({ t: e.timeStamp, x: t.clientX, y: t.clientY })
    if (g.trail.length > 6) g.trail.shift()
    if (g.axis === null) {
      if (Math.abs(dx) <= 8 && Math.abs(dy) <= 8) return
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      g.lx = dx; g.ly = dy
      // The finger owns the photo now: land the open if it is still flying and drop every
      // filled animation, so the inline transform below is what paints.
      const flight = flightRef.current
      if (flight?.playState === 'running') flight.finish()
      box.getAnimations().forEach((a) => a.cancel())
      box.style.transform = ''
      box.style.clipPath = ''
      box.style.opacity = ''
      if (g.axis === 'x') mountSides(root, box, 0)
      else {
        backdrop.getAnimations().forEach((a) => a.cancel())
        chrome.getAnimations().forEach((a) => a.cancel())
        cancelAnimationFrame(veilRaf.current)
      }
    }
    if (g.axis === 'x') {
      const raw = dx - g.lx
      // Rubber-band where there is no neighbour: the photo gives a little, then resists.
      const atEnd = g.base === 0 && ((raw > 0 && index <= 0) || (raw < 0 && index >= items.length - 1))
      g.ox = atEnd ? raw * 0.35 : raw
      const at = g.base + g.ox
      shiftX(box, at)
      g.ghostBase.forEach((gx, el) => shiftX(el, gx + g.ox))
      sides.current.forEach((sd) => shiftX(sd.el, sd.delta * innerWidth + at))
    } else {
      g.oy = Math.max(0, dy - g.ly) // downward only, from the point of lock
      box.style.transform = `translateY(${g.oy}px)`
      const k = revealAt(g.oy)
      backdrop.style.opacity = String(k)
      chrome.style.opacity = String(k)
      setVeil(k)
    }
  }
  const onTouchEnd = () => {
    const g = touch.current
    touch.current = null
    const box = boxRef.current, backdrop = backdropRef.current, chrome = chromeRef.current
    if (!g || !g.axis || !box || !backdrop || !chrome) return // a tap falls through to click
    // Release velocity (px/s) over the last few samples: the speed the finger left at.
    const a = g.trail[0], b = g.trail[g.trail.length - 1]
    const dt = Math.max(1, b.t - a.t) / 1000
    const fresh = performance.now() - b.t < 80 // a finger that paused before lifting threw nothing
    const vx = fresh ? (b.x - a.x) / dt : 0
    const vy = fresh ? (b.y - a.y) / dt : 0
    const rm = reduced()

    if (g.axis === 'x') {
      // Commit on distance, or on a flick: FLICK px/s in the direction already travelled.
      const threshold = Math.min(innerWidth * 0.25, 90)
      const dir = g.ox <= -threshold || (vx < -FLICK && g.ox < -8) ? 1 : g.ox >= threshold || (vx > FLICK && g.ox > 8) ? -1 : 0
      if (dir && go(dir, vx)) return
      // Not far enough, or nothing that way: the whole track springs back, quickly.
      const at = g.base + g.ox
      const spring = springSamples(at, 0, vx)
      const ms = rm ? 0 : spring.ms
      const ride = (n: HTMLElement, offset: number) =>
        n.animate(spring.xs.map((v) => ({ transform: `translateX(${(v + offset).toFixed(2)}px)` })), { duration: ms, easing: 'linear', fill: 'both' })
      box.style.transform = ''
      navRef.current = ride(box, 0)
      const leaving = [...sides.current.map((sd) => ({ el: sd.el, offset: sd.delta * innerWidth })), ...ghosts.current.map((el) => ({ el, offset: xOf(el) - at }))]
      sides.current = []
      ghosts.current = []
      for (const piece of leaving) ride(piece.el, piece.offset).finished.catch(() => {}).then(() => piece.el.remove())
    } else {
      // Pulled far enough, or flicked down: leave. The photo flies back to its place on the page.
      if (g.oy > CLOSE_DRAG || (vy > FLICK && g.oy > 8)) return close()
      // Otherwise back up, with the backdrop derived from the SAME samples as the photo, so
      // the two can never drift apart.
      const spring = springSamples(g.oy, 0, vy)
      const timing = { duration: rm ? 0 : spring.ms, easing: 'linear' }
      const dims = spring.xs.map((v) => ({ opacity: revealAt(v) }))
      box.style.transform = ''
      backdrop.style.opacity = '1'
      chrome.style.opacity = '1'
      box.animate(spring.xs.map((v) => ({ transform: `translateY(${v.toFixed(2)}px)` })), timing)
      chrome.animate(dims, timing)
      backdrop.animate(dims, timing).finished.then(() => { if (!closing.current) setVeil(1) }).catch(() => {})
    }
  }

  // A drag interrupted by an unmount must not leave its pieces behind.
  useEffect(() => dropExtras, [])

  if (!view || typeof document === 'undefined') return null
  const { item } = view
  const exif = formatExif(item.exif)
  const caption = item.caption ?? null
  const label = caption ?? item.alt ?? null
  const total = items.length
  const isStart = !navigated && view.index === start.index
  const BTN = 'dk-chrome-btn pointer-events-auto flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--dk-fg)] transition-colors hover:bg-[var(--dk-surface)] active:bg-[var(--dk-surface)]'
  const LAYER = 'absolute inset-0 h-full w-full object-cover'

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={label ?? (item.videoSrc ? 'Video' : 'Photo')}
      // Programmatically focusable so focus enters the dialog on open; -1 keeps it out of the
      // Tab order itself.
      tabIndex={-1}
      // .dk-scope carries the --dk-* tokens. left-0 + a measured width, not inset-0: the modal
      // must also cover the strip a host page reserves for a classic scrollbar.
      className="dk-scope fixed inset-y-0 left-0 z-50 w-screen select-none overflow-hidden text-[var(--dk-fg)] outline-none"
      // touchAction: the gestures here are the lightbox's, never the page's scroll or zoom.
      style={{ touchAction: 'none', overscrollBehavior: 'contain' }}
      // A click or tap anywhere that is not a control closes, the photo included.
      onClick={(e) => { if (!(e.target as Element).closest('button, a, video[controls]')) close() }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      // The gesture was taken away (a system swipe, a second finger): treat it as a release.
      onTouchCancel={onTouchEnd}
    >
      <div ref={backdropRef} className="absolute inset-0" style={{ background: 'var(--dk-bg)', opacity: 0 }} />
      {/* Arrow keys and the buttons swap the item without any announcement (a changed
          aria-label on the dialog is never re-read); this is what a screen reader hears. */}
      <div role="status" className="sr-only">
        {`${item.videoSrc ? 'Video' : 'Photo'} ${view.index + 1} of ${total}${label ? `: ${label}` : ''}`}
      </div>

      {/* The item: the page element's own file first, the sharp file fading up inside the
          flight. Its colour sits behind both, so a neighbour whose thumbnail has not loaded
          yet arrives as its colour rather than as a hole. */}
      <div ref={boxRef} className="absolute overflow-hidden" style={{ transformOrigin: '0 0', willChange: 'transform', backgroundColor: item.color }}>
        {/* Keyed by item: an <img> whose src changes keeps painting the old file until the new
            one loads, which would put the previous photo in the incoming slide. */}
        <img key={view.index} ref={baseRef} src={(isStart && start.poster) || view.src} alt={view.hi || item.videoSrc ? '' : item.alt ?? item.caption ?? ''} className={LAYER} draggable={false} />
        {view.hi && <img key={`hi-${view.index}`} ref={hiRef} data-dk-hi src={view.hi} alt={item.alt ?? item.caption ?? ''} className={LAYER} style={{ opacity: 0 }} draggable={false} />}
        {item.videoSrc && <Clip key={`clip-${view.index}`} src={item.videoSrc} time={isStart ? start.videoTime ?? 0 : 0} />}
        {showOutline && <div aria-hidden className="dk-img-outline pointer-events-none absolute inset-0" />}
      </div>

      {/* Chrome: present from the first frame. */}
      <div ref={chromeRef} className="pointer-events-none absolute inset-0" style={{ opacity: 0 }}>
        <button
          ref={closeRef}
          type="button"
          onClick={(e) => { e.stopPropagation(); close() }}
          aria-label="Close"
          style={{ right: 'var(--dk-chrome-inset, 16px)' }}
          className={`${BTN} absolute top-3`}
        >
          <IconClose />
        </button>

        {/* The dock: the arrows, with the caption between them in theme ink, under the photo
            rather than on it. A click on the dock is not a click on the backdrop.
            .dk-rail-foot keeps it clear of a phone's home indicator. On a phone the caption
            takes the full width on its own line above the arrows. */}
        <div
          ref={dockRef}
          onClick={(e) => e.stopPropagation()}
          className="dk-rail-foot pointer-events-auto absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 pt-3 max-sm:flex-wrap"
          style={{ paddingLeft: 'var(--dk-chrome-inset, 16px)', paddingRight: 'var(--dk-chrome-inset, 16px)' }}
        >
          <button type="button" onClick={(e) => { e.stopPropagation(); go(-1, 0, e.shiftKey) }} aria-label="Previous" disabled={view.index <= 0} className={`${BTN} disabled:invisible`}>
            <IconPrev />
          </button>
          <div className="flex min-w-0 flex-1 justify-center max-sm:order-first max-sm:basis-full">
            {hasCaptions && (caption || exif) && (
              <div className="max-w-[60ch] select-text text-center">
                {caption && <p className="font-[family-name:var(--dk-font-sans)] text-[14px] leading-[1.35]">{caption}</p>}
                {/* Wraps rather than truncates: a phone's EXIF line must stay whole. */}
                {exif && <p className={`${caption ? 'mt-0.5 ' : ''}font-[family-name:var(--dk-font-mono)] text-[11px] leading-[1.5] text-[var(--dk-muted)]`}>{exif}</p>}
              </div>
            )}
          </div>
          <button type="button" onClick={(e) => { e.stopPropagation(); go(1, 0, e.shiftKey) }} aria-label="Next" disabled={view.index >= total - 1} className={`${BTN} disabled:invisible`}>
            <IconNext />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------------------------------------
 * useDKLightbox — the controller both openers (grid, carousel) drive the lightbox through.
 * Owns: the open session and its click-time capture (origin rect, video frame), the modality
 * tracking that decides whether close restores a focus ring, scroll restore, pausing the
 * opener's other clips, and deep links.
 * ---------------------------------------------------------------------------------------------- */

// Returns focus to `el` after the modal closes. `withRing` should be true only when the session
// showed real keyboard navigation (a Tab press, or a keyboard-activated open): those users need
// the :focus-visible ring to see where they landed. A mouse user who pressed Escape just gets
// their focus position back with no ring — the browser's own heuristic counts Escape as
// "keyboard" and would flash the ring at them, which is exactly the over-trigger this avoids.
function restoreFocus(el: HTMLElement, withRing: boolean) {
  el.focus({ preventScroll: true })
  el.scrollIntoView({ block: 'nearest' })
  if (withRing) return
  // Suppress the ring for this landing only — ALL THREE pieces of any global :focus-visible
  // recipe the host site may have: an outline, a box-shadow halo, AND a border-radius. Inline
  // styles win over the rule; lifted the moment focus moves on or the keyboard comes into play.
  const prevOutline = el.style.outline
  const prevShadow = el.style.boxShadow
  const prevRadius = el.style.borderRadius
  const lift = () => {
    el.style.outline = prevOutline
    el.style.boxShadow = prevShadow
    el.style.borderRadius = prevRadius
    el.removeEventListener('blur', lift)
    window.removeEventListener('keydown', lift)
  }
  el.style.outline = 'none'
  el.style.boxShadow = 'none'
  el.style.borderRadius = '0'
  el.addEventListener('blur', lift, { once: true })
  window.addEventListener('keydown', lift, { once: true })
}

export interface DKLightboxOptions {
  /** A sharper large variant to fade in over the base image (and to prefetch around the current
   *  one). Return item.src (or nothing) to opt an item out. */
  getHiResSrc?: (item: DKMediaItem) => string
  /** Show the caption/EXIF line. Default: on when any item carries a caption or EXIF. */
  hasCaptions?: boolean
  /** A 1px photo edge outline in the modal. Default off. */
  showOutline?: boolean
  /** Open from `?photo=<index>` on mount (and strip the param), for shareable deep links. */
  deepLink?: boolean
  /** The on-page element for an item: the flight's origin and destination, and where focus
   *  goes back on close. Wire this to a ref registry of your thumbnails. */
  getOriginEl?: (index: number) => HTMLElement | null
  /** Fired as the modal begins to close, with the index the viewer was on — e.g. so a carousel
   *  can turn to the slide they navigated to before the photo flies back to it. */
  onClose?: (index: number) => void
}

export function useDKLightbox(items: DKMediaItem[], options: DKLightboxOptions = {}) {
  const [session, setSession] = useState<(DKLightboxStart & { id: number }) | null>(null)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const itemsRef = useRef(items)
  useEffect(() => { itemsRef.current = items }, [items])
  const optionsRef = useRef(options)
  useEffect(() => { optionsRef.current = options })
  const opens = useRef(0)
  // The item last shown: close hands focus back to ITS element, not the one entered through.
  const latestIndexRef = useRef<number | null>(null)
  // Videos elsewhere in the opener's scope, paused while the overlay is open — otherwise they
  // keep playing behind the fading-in backdrop. Resumed on close.
  const pausedRef = useRef<HTMLVideoElement[]>([])
  // The page's scroll position at open. Close restores it EXACTLY: traversing the modal must
  // not move the reader.
  const scrollPosRef = useRef<{ x: number; y: number } | null>(null)
  // Did this session show REAL keyboard navigation (keyboard-activated open, or a Tab while
  // open)? Only then does the restored element show its focus ring. Escape/arrows don't count.
  const keyboardModeRef = useRef(false)
  const open_ = session !== null
  useEffect(() => {
    if (!open_) return
    const onTab = (e: KeyboardEvent) => { if (e.key === 'Tab') keyboardModeRef.current = true }
    window.addEventListener('keydown', onTab)
    return () => window.removeEventListener('keydown', onTab)
  }, [open_])

  const leaving = useCallback((idx: number) => { optionsRef.current.onClose?.(idx) }, [])
  // What close owes the page once the dialog is gone: focus back on the item's element, and
  // the reader's scroll position.
  const restoreRef = useRef<{ idx: number; withRing: boolean; pos: { x: number; y: number } | null } | null>(null)
  const finish = useCallback((idx: number) => {
    restoreRef.current = { idx, withRing: keyboardModeRef.current, pos: scrollPosRef.current }
    scrollPosRef.current = null
    setSession(null)
    setActiveIndex(null)
    latestIndexRef.current = null
    pausedRef.current.forEach((v) => v.play().catch(() => {}))
    pausedRef.current = []
  }, [])
  // Paid in an effect on the session ending, not on a timer: the dialog's own cleanup (which
  // lifts `inert` from the page) is guaranteed to have run by then, and focusing an inert
  // element is a silent no-op. A frame's delay was not a guarantee; React may commit later.
  useEffect(() => {
    const owed = restoreRef.current
    if (open_ || !owed) return
    restoreRef.current = null
    const el = optionsRef.current.getOriginEl?.(owed.idx) ?? null
    if (el) restoreFocus(el, owed.withRing)
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    // AFTER restoreFocus (whose scrollIntoView may have moved the page): put the reader back
    // precisely where they were. Same task, so only the final position ever paints.
    if (owed.pos) window.scrollTo(owed.pos.x, owed.pos.y)
  }, [open_])
  /** Close at once, without the return flight (the lightbox's own close animates). */
  const close = useCallback(() => {
    const idx = latestIndexRef.current
    if (idx === null) return
    leaving(idx)
    finish(idx)
  }, [finish, leaving])
  const navigated = useCallback((idx: number) => { latestIndexRef.current = idx; setActiveIndex(idx) }, [])

  /** Open the lightbox on `items[index]`, flying in from `el` (the clicked thumbnail/slide).
   *  Pass the click event (or its shiftKey/detail) so slow-mo and keyboard modality register. */
  const open = useCallback((index: number, el?: HTMLElement | null, e?: { shiftKey?: boolean; detail?: number }) => {
    const item = itemsRef.current[index]
    if (!item) return
    // A keyboard-activated button fires click with detail 0 — that's a keyboard open.
    keyboardModeRef.current = (e?.detail ?? 1) === 0
    scrollPosRef.current = { x: window.scrollX, y: window.scrollY }
    const start: DKLightboxStart & { id: number } = { id: ++opens.current, index, rect: el ? rectOf(el) : null, slow: !!e?.shiftKey }
    const video = el ? el.querySelector('video') ?? (el instanceof HTMLVideoElement ? el : null) : null
    if (el && item.videoSrc && video) {
      // The modal player resumes from this exact frame.
      start.videoTime = video.currentTime || 0
      // Freeze the exact on-screen frame as the flying copy's picture: a brand-new <video>
      // needs metadata and a seek before it paints anything. Same-origin clips only; a tainted
      // canvas just skips the snapshot and the poster flies instead. ONLY the clicked clip:
      // this is a synchronous drawImage + JPEG encode inside the click handler.
      try {
        if (video.readyState >= 2 && video.videoWidth) {
          const c = document.createElement('canvas')
          c.width = video.videoWidth
          c.height = video.videoHeight
          c.getContext('2d')?.drawImage(video, 0, 0)
          start.poster = c.toDataURL('image/jpeg', 0.85)
        }
      } catch { /* cross-origin frame — no snapshot */ }
    }
    if (el) {
      // Freeze the other playing clips in this opener's scope while the overlay is open.
      const scope = el.closest('[data-dk-scope]') ?? document
      const playing = Array.from(scope.querySelectorAll<HTMLVideoElement>('video')).filter((v) => !v.paused)
      playing.forEach((v) => v.pause())
      pausedRef.current = playing
    }
    latestIndexRef.current = index
    setActiveIndex(index)
    setSession(start)
  }, [])

  // Deep-link: ?photo=<index> opens that item's lightbox on load. Uses the thumbnail's rect as
  // the zoom origin, then strips the param so a later refresh/back doesn't reopen it.
  useEffect(() => {
    if (!optionsRef.current.deepLink) return
    const raw = new URLSearchParams(window.location.search).get('photo')
    if (raw === null) return
    const idx = Number(raw)
    if (!Number.isInteger(idx) || idx < 0 || idx >= itemsRef.current.length) return
    const el = optionsRef.current.getOriginEl?.(idx) ?? null
    el?.scrollIntoView({ block: 'center' })
    open(idx, el)
    const url = new URL(window.location.href)
    url.searchParams.delete('photo')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasCaptions = options.hasCaptions ?? items.some((p) => p.caption || formatExif(p.exif))

  // DKLightbox portals itself to <body>, so it is a sibling of the page content it makes inert.
  const lightbox = session ? (
    <DKLightbox
      key={session.id}
      items={items}
      start={session}
      getOriginEl={options.getOriginEl}
      getHiResSrc={options.getHiResSrc}
      hasCaptions={hasCaptions}
      showOutline={options.showOutline ?? false}
      onNavigate={navigated}
      onLeaving={leaving}
      onClose={finish}
    />
  ) : null

  return { open, close, isOpen: session !== null, activeIndex, lightbox }
}
