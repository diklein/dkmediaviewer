'use client'

/* DKLightbox — the fly-in modal viewer, plus useDKLightbox(), the controller hook the grid
 * (dk-media-viewer) and the carousel (dk-carousel) both drive it through.
 *
 * Extracted from diklein.com, where every timing decision below was measured against a real
 * Safari/Chrome flash or jitter before it earned its comment. The war stories are kept: they
 * are the reason the code is shaped the way it is, and deleting them invites regressing it. */

import { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react'
import { flushSync } from 'react-dom'
import { createPortal } from 'react-dom'
import {
  AnimatePresence,
  LazyMotion,
  domAnimation,
  m,
  useMotionValue,
  useTransform,
  animate,
  useReducedMotion,
} from 'motion/react'
import type { DKMediaItem } from './types'
import { formatExif } from './types'

/* ------------------------------------------------------------------------------------------------
 * The lightbox's working item: the public DKMediaItem plus runtime capture the opener takes at
 * click time. None of this is hand-written by users — useDKLightbox fills it in.
 * ---------------------------------------------------------------------------------------------- */
export interface DKLightboxItem extends DKMediaItem {
  /** The origin <img>'s decoded file (its currentSrc) — the fly-in clone and the slide's base
   *  layer paint this straight from cache, so the open never waits on a re-fetch. */
  flightSrc?: string
  /** A canvas snapshot of the exact video frame that was clicked — the clone's guaranteed paint
   *  while its own <video> is still seeking. */
  flightPoster?: string
  /** The clip's playhead at click; the clone and the modal player both resume from this frame. */
  videoTime?: number
  /** Mirror a progress bar under the clip in the modal. */
  videoProgress?: boolean
}

// Should the clicked clip keep PLAYING while it flies into the modal?
//
// TRUE (the shipped behaviour): the flying clone is a second live <video> that resumes from the
// origin's exact frame, so the clip never stops moving as it travels into the modal.
//
// FALSE: the clone is the FROZEN frame instead (flightPoster, a canvas snapshot of the clicked
// frame). Identical pixels, no video element inside the animating layer; the clip just does not
// advance during the flight. The handoff is frame-accurate either way, because the modal clip
// starts from item.videoTime — the same frame the clone starts from — and both play at 1x, so
// they stay together without anything having to reconcile them (see LightboxVideo).
const FLY_LIVE_VIDEO = true

/* THE HOUSE SPRING. ζ ≈ 0.86, ωₙ ≈ 30: about half a percent of overshoot, settled in ~150ms —
 * present, not gratuitous. Overshoot is a percentage of the distance travelled, so one spring
 * serves an 8px settle and an 800px flight alike; the drag settle, the fly-in open and the
 * left/right nav all share it deliberately, so the same gesture always feels like the same
 * object. */
const SPRING = { type: 'spring', stiffness: 620, damping: 36, mass: 0.7 } as const
const OPEN_SPRING = SPRING // the fly-in from the thumbnail
const NAV_SPRING = SPRING // left / right between assets
/* prefers-reduced-motion: the MOVE is kept — it carries spatial meaning — but the decorative
 * overshoot is removed. Critically damped: it arrives and stops. */
const NAV_SPRING_REDUCED = { type: 'spring', stiffness: 300, damping: 40, mass: 1 } as const
/* Shift-click / shift-arrow: the same character stretched to ~3s, so every phase of the
 * entrance can be inspected frame by frame. (Mac OS X 10.3 shipped shift-click-minimize as a
 * slow-motion genie effect. Some of us never got over it.) */
const SPRING_SLOW = { type: 'spring', duration: 3, bounce: 0.2 } as const
const SLOW_OPEN_SPRING = SPRING_SLOW
const SLOW_NAV_SPRING = SPRING_SLOW
const CLOSE_DRAG = 100 // swipe the image down past this (px) to dismiss

// Contain-fit a photo of intrinsic (w×h) inside a container rect → the image's actual on-screen
// rectangle. The flying-clone open flies to THIS rect (not the container's), so start and end
// share the photo's aspect ratio and the clone scales uniformly — a pure GPU transform, no
// distortion (which independent width/height or scaleX≠scaleY would cause).
function containRect(
  c: { left: number; top: number; width: number; height: number },
  w: number,
  h: number,
) {
  if (!w || !h) return { left: c.left, top: c.top, width: c.width, height: c.height }
  const ar = w / h
  let iw = c.width
  let ih = c.width / ar
  if (ih > c.height) { ih = c.height; iw = c.height * ar }
  return { left: c.left + (c.width - iw) / 2, top: c.top + (c.height - ih) / 2, width: iw, height: ih }
}

function IconClose() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 2L14 14M14 2L2 14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  )
}

function IconArrow({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      {dir === 'left'
        ? <path d="M11 3L5 9L11 15" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M7 3L13 9L7 15" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      }
    </svg>
  )
}

export interface DKLightboxProps {
  item: DKLightboxItem
  index: number
  total: number
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  originRect: DOMRect | null
  prevItem: DKLightboxItem | null
  nextItem: DKLightboxItem | null
  /** Reserve space for a caption/exif line under the image. When no item in the gallery carries
   *  either, turn this off — the image then gets the freed vertical space. */
  hasCaptions?: boolean
  /** The 1px edge outline on the photo (matches the grid's .dk-img-outline treatment and keeps
   *  near-white / near-black photographs from merging into the scrim). Turn off for assets that
   *  are not photographs — on screenshots and diagrams it reads as a stray border flashing in
   *  and out as the overlay opens. */
  showOutline?: boolean
  /** Shift-click open: stretch the whole entrance to ~3s for frame-by-frame inspection. */
  slowMo?: boolean
  /** A sharper large variant to fade in over the base image (e.g. a CDN resize URL). Default:
   *  none — the lightbox shows item.src, which is already the full file for local photos. */
  getHiResSrc?: (item: DKMediaItem) => string
  /** Fired ONCE, when the fly-in clone paints its first real frame (image decoded / first
   *  video frame). The opener hides the clicked origin element on this signal rather than at
   *  click, so the asset never blinks out before its flying copy is visibly on screen. */
  onFlightPainted?: () => void
}

/** Loading shimmer sized to the asset's contained (letterboxed) rect rather than the whole
 *  slide — so while a wide clip or tall photo loads, the placeholder matches the shape that
 *  will appear, not the entire modal. Falls back to filling the slide if the aspect is
 *  unknown (dimensions weren't supplied). */
// Measures a photo's object-contain rect (w x h fitted inside the host box), tracking resize.
// Shared by the loading shimmer and the persistent edge outline so both hug the photo exactly.
function useContainRect(w?: number, h?: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const host = ref.current
    if (!host || !w || !h) { setBox(null); return }
    const measure = () => {
      const cw = host.clientWidth, ch = host.clientHeight
      if (!cw || !ch) return
      const a = w / h
      let dw = cw, dh = cw / a
      if (dh > ch) { dh = ch; dw = ch * a }
      setBox({ w: Math.round(dw), h: Math.round(dh) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [w, h])
  return { ref, box }
}

function AssetShimmer({ w, h }: { w?: number; h?: number }) {
  const { ref, box } = useContainRect(w, h)
  return (
    <div ref={ref} aria-hidden className="absolute inset-0 z-0 flex items-center justify-center">
      <div
        className="dk-shimmer relative"
        style={box ? { width: box.w, height: box.h } : { position: 'absolute', inset: 0 }}
      />
    </div>
  )
}

// Persistent neutral edge outline hugging the photo's contained rect — the same 1px treatment as
// the grid (.dk-img-outline), so near-white / near-black photos don't merge with the scrim.
// Sits above both image layers (z-30) so its inward outline paints over the photo's edge; photos
// only, as videos keep their own progress-bar treatment.
function AssetOutline({ w, h }: { w?: number; h?: number }) {
  const { ref, box } = useContainRect(w, h)
  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
      {box && <div className="dk-img-outline" style={{ width: box.w, height: box.h }} />}
    </div>
  )
}

/** A clip playing inside the lightbox: shimmer while it loads, then a 2px accent progress bar
 *  matched to the video's contained (letterboxed) rect. Only the current slide autoplays; on
 *  nav the slide remounts (keyed by src) so it reliably plays. */
function LightboxVideo({ item, priority, onLoad, armed = true }: { item: DKLightboxItem; priority?: boolean; onLoad?: () => void; armed?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  // The REVEAL must not run until the fly-in has landed — otherwise the modal clip would appear
  // over the top of the clone that is still flying. This clip is already playing by then (in sync
  // with the clone); it is simply invisible, behind the transparent container. Deferred here and
  // re-fired the moment `armed` flips.
  const armedRef = useRef(armed)
  const pendingRef = useRef(false)
  const revealRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    armedRef.current = armed
    if (armed && pendingRef.current) { pendingRef.current = false; revealRef.current?.() }
  }, [armed])
  const onLoadRef = useRef(onLoad)
  useEffect(() => { onLoadRef.current = onLoad })
  const [progress, setProgress] = useState(0)
  const [ready, setReady] = useState(false)
  const [bar, setBar] = useState<{ w: number; left: number; top: number } | null>(null)
  // The clip's own dimensions size the loading shimmer to its contained rect. Seeded from the
  // item's declared dimensions, then corrected from the modal video's own loadedmetadata — so a
  // clip without dimensions still gets a clip-shaped shimmer once metadata lands.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(
    item.width && item.height ? { w: item.width, h: item.height } : null,
  )
  const showBar = !!item.videoProgress

  useEffect(() => {
    const v = ref.current
    if (!v) return
    const onTime = () => { const d = v.duration; if (d && Number.isFinite(d)) setProgress(v.currentTime / d) }
    // Match the bar to the video's contained rect. The clip is laid out in the top of the
    // slide, leaving a 10px strip below (8px gap + 2px bar) so the bar never overlaps it.
    const measure = () => {
      const host = v.parentElement
      if (!host) return
      if (v.videoWidth && v.videoHeight) setDims({ w: v.videoWidth, h: v.videoHeight })
      const cw = host.clientWidth, ch = host.clientHeight
      const availH = ch - (showBar ? 10 : 0)
      const a = (v.videoWidth || 16) / (v.videoHeight || 9)
      let dw = cw, dh = cw / a
      if (dh > availH) { dh = availH; dw = availH * a }
      setBar({ w: dw, left: (cw - dw) / 2, top: (availH - dh) / 2 + dh + 8 })
    }
    // THIS CLIP RUNS IN SYNC WITH THE FLYING CLONE, from the moment it has metadata.
    //
    // It used to sit paused through the whole flight and only seek to the clone's live position at
    // the handoff — and to keep the clone from drifting past the frame being handed over, the clone
    // was PAUSED while that seek ran. Measured in Safari, that froze the picture for 175ms while
    // the seek, the painted-frame wait, the React commit and the clone's two-frame overlap all
    // stacked up: a visible split-second pause right after the animation completed.
    //
    // The stall existed only because the two clips were at different times and had to be
    // reconciled. So don't let them diverge: both start from the same captured frame
    // (item.videoTime) and both play at 1x from there, so they stay together on their own. The
    // handoff is then a pure swap of two videos already showing the same thing — no seek, no pause,
    // nothing to reconcile, and the clip never stops moving.
    let started = false
    let revealed = false
    const startPlayback = () => {
      if (started) return
      started = true
      // Match the clone's starting frame. Only the clicked clip (priority) does this; neighbours
      // rest at frame 0 until they are swiped to.
      if (priority && item.videoTime && v.currentTime < 0.05) {
        try { v.currentTime = item.videoTime } catch { /* not seekable yet — plays from 0 */ }
      }
      if (priority) v.play().catch(() => {})
    }
    let done = false
    const reveal = () => {
      if (done) return
      done = true
      // Seed the bar with the position the clip is ACTUALLY at, in the same commit it first mounts.
      // It used to mount at 0 and only get a real value on the first `timeupdate`, and because the
      // fill carries a width transition, that value then animated in from the left edge: the bar
      // appeared empty and visibly chased the playhead. A freshly-inserted element does not
      // transition its initial value, so setting it here means the bar's first paint is already in
      // the right place; later timeupdates still glide.
      const d = v.duration
      if (d && Number.isFinite(d)) setProgress(v.currentTime / d)
      setReady(true)
      onLoadRef.current?.()
    }
    // Reveal on a PAINTED frame, never on an event.
    //
    // An event says the decoder is done, not that the frame is on screen — WebKit paints it on the
    // next compositor tick. Measured in Safari: `seeked` at 592ms, the frame painted at 604ms.
    // Handing the stage over inside that 12ms window (clone unmounted, modal video not yet showing
    // anything) was a flash at the END of the open animation, exactly as painting frame 0 before
    // the seek landed was the flash at the START (see FlightVideo). requestVideoFrameCallback fires
    // only once a frame has actually been presented, so gating on it makes the swap frame-exact.
    // The clip is playing by now, so frames keep coming and this always fires.
    const revealOnPaintedFrame = () => {
      if (revealed) return
      revealed = true
      const rvfc = (v as RVFCVideo).requestVideoFrameCallback
      if (!rvfc) { reveal(); return } // no rVFC: this is the best signal available
      const to = window.setTimeout(reveal, 120) // safety net if playback never starts
      rvfc.call(v, () => { window.clearTimeout(to); reveal() })
    }
    revealRef.current = revealOnPaintedFrame
    const onReady = () => {
      measure()
      startPlayback() // in sync with the clone, from the first moment it can be
      if (revealed) return
      // The flight has not landed yet: keep this clip playing BEHIND the clone (the container is
      // still transparent) and reveal the moment `armed` flips.
      if (!armedRef.current) { pendingRef.current = true; return }
      revealOnPaintedFrame()
    }
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('loadeddata', onReady)
    v.addEventListener('canplay', onReady)
    v.addEventListener('playing', onReady)
    v.addEventListener('loadedmetadata', measure)
    // Reveal precisely on the first painted frame where supported, so the clone→video swap is
    // frame-exact (no flash).
    type RVFCVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
    const rvfc = (v as RVFCVideo).requestVideoFrameCallback
    if (rvfc) rvfc.call(v, () => onReady())
    if (v.readyState >= 2) onReady() // frame 0 already decoded (e.g. bfcache)
    if (v.videoWidth) measure()
    const ro = new ResizeObserver(measure)
    if (v.parentElement) ro.observe(v.parentElement)
    return () => {
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('loadeddata', onReady)
      v.removeEventListener('canplay', onReady)
      v.removeEventListener('playing', onReady)
      v.removeEventListener('loadedmetadata', measure)
      ro.disconnect()
    }
  }, [priority, item.videoSrc, item.videoTime, showBar])

  return (
    <>
      {!ready && <AssetShimmer w={dims?.w} h={dims?.h} />}
      <video
        ref={ref}
        src={item.videoSrc}
        muted
        loop
        playsInline
        preload={priority ? 'auto' : 'metadata'}
        // No poster: the reveal waits for the clip to paint, so it shows frame 0 directly with
        // no poster→video swap. A <video> is a replaced element, so left/right insets don't
        // stretch it — size it explicitly, leaving a 10px strip for the bar when shown.
        style={{ height: showBar ? 'calc(100% - 10px)' : '100%' }}
        className="absolute inset-x-0 top-0 z-10 w-full object-contain"
      />
      {/* Gated on `ready` — i.e. it mounts with the clip's real position already seeded (see
          reveal()) — and eased in, so it resolves with the clip instead of snapping into existence
          under it the instant the geometry is measured. */}
      {showBar && bar && ready && (
        <m.div
          aria-hidden
          className="absolute z-20 h-0.5 overflow-hidden rounded-full"
          style={{ width: bar.w, left: bar.left, top: bar.top, background: 'color-mix(in srgb, currentColor 22%, transparent)' }}
          // Half a second, accelerating (easeIn), and it only starts once the fly-in has landed —
          // the bar does not mount until the clip reveals, which is gated on the open animation
          // finishing. So it emerges quietly under the settled clip rather than competing with it.
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, ease: 'easeIn' }}
        >
          <div className="h-full w-full origin-left" style={{ transform: `scaleX(${progress})`, background: 'var(--dk-accent)', transition: 'transform 0.25s linear' }} />
        </m.div>
      )}
    </>
  )
}

/** One image in the swipe track, offset by translateX so prev/current/next sit side by
 *  side. The base layer reuses the grid's already-loaded file (instant, from cache); a sharper
 *  variant (getHiResSrc) fades in on top once loaded — for every visible slide, so a swipe/nav
 *  always lands on a hi-res image. */
function Slide({ item, offset, priority, hiRes = true, getHiResSrc, onLoad, showOutline = true, armed = true }: {
  item: DKLightboxItem
  offset: string
  priority?: boolean
  /** Load the sharp layer. Off for neighbours during the open animation so five big images
   *  don't decode at once and jitter the spring — they upgrade once the overlay has opened. */
  hiRes?: boolean
  getHiResSrc?: (item: DKMediaItem) => string
  onLoad?: () => void
  /** The 1px edge outline — see DKLightboxProps.showOutline. */
  showOutline?: boolean
  /** Has the fly-in landed? The clip plays behind the flying clone either way; this only gates
   *  the REVEAL, so the modal clip cannot appear on top of a clone still in the air. */
  armed?: boolean
}) {
  const [hiResLoaded, setHiResLoaded] = useState(false)
  const [baseLoaded, setBaseLoaded] = useState(false)

  // Video items play in place of the image layers (shimmer + progress bar live in
  // LightboxVideo). Only the current slide (priority) autoplays; neighbours rest until
  // swiped to, so opening the overlay never decodes three clips at once.
  if (item.videoSrc) {
    return (
      <div className="absolute inset-0" style={{ transform: `translateX(${offset})` }}>
        {/* The slide spans the full track width so it can travel fully off-screen; the asset is
            inset 16px so it never bleeds to the very edge at rest (the margins live here, not on
            the clipped container, so they don't cut the slide short). */}
        <div className="absolute inset-y-0 inset-x-4">
          <LightboxVideo item={item} priority={priority} onLoad={onLoad} armed={armed} />
        </div>
      </div>
    )
  }

  // The base layer prefers flightSrc — the exact file the origin <img> had already decoded,
  // served verbatim — so the track is painted before the fly-in lands even on a cold cache.
  const baseSrc = item.flightSrc || item.src
  // The sharper large variant, if the host supplies one (e.g. a CDN resize URL). Skipped when
  // it resolves to the file already on screen — nothing to upgrade to.
  const hiResUrl = getHiResSrc?.(item)
  const showHiRes = !!hiResUrl && hiResUrl !== baseSrc
  const loading = priority ? undefined : ('eager' as const)
  return (
    <div className="absolute inset-0" style={{ transform: `translateX(${offset})` }}>
      {/* Full-width slide (travels fully off-screen), asset inset 16px so it keeps its margins at
          rest without the container's clip cutting the slide short mid-animation. */}
      <div className="absolute inset-y-0 inset-x-4">
        {!baseLoaded && <AssetShimmer w={item.width} h={item.height} />}
        <img
          src={baseSrc}
          alt={item.alt ?? item.caption ?? ''}
          className="absolute inset-0 z-10 h-full w-full object-contain"
          loading={loading}
          decoding={priority ? 'sync' : 'async'}
          draggable={false}
          onLoad={() => { setBaseLoaded(true); onLoad?.() }}
        />
        {hiRes && showHiRes && (
          <img
            src={hiResUrl}
            alt=""
            aria-hidden
            className="absolute inset-0 z-20 h-full w-full object-contain"
            loading={loading}
            decoding="async"
            draggable={false}
            onLoad={() => setHiResLoaded(true)}
            style={{ opacity: hiResLoaded ? 1 : 0, transition: 'opacity 300ms ease-out' }}
          />
        )}
        {showOutline && <AssetOutline w={item.width} h={item.height} />}
      </div>
    </div>
  )
}

/** The still frame under a flying video clone. It is what guarantees the clone always has
 *  something painted: `flightPoster` (a canvas snapshot of the exact clicked frame) when the clip
 *  had decoded a frame, else the item's own poster image, which always exists. The live <video>
 *  layers on top and covers this as soon as it has a real frame. Without it, the clone is
 *  transparent while the video seeks — a hole showing the scrim through it. */
function FlightStill({ item, onPainted, hidden = false }: { item: DKLightboxItem; onPainted: () => void; hidden?: boolean }) {
  const src = item.flightPoster || item.src
  if (!src) return null
  return (
    <img
      src={src}
      className="absolute inset-0 h-full w-full object-contain"
      alt=""
      aria-hidden
      // Gone the moment the live video above it is actually painting.
      //
      // This still is a snapshot of the frame you CLICKED, and it never updates. It used to sit at
      // full opacity under the clone for the entire flight — measured: by the end the video above it
      // was 450ms of clip further on, while this was frozen at the click frame. Safari transiently
      // drops the video layer while re-compositing the transform (proven at the handoff), and when
      // it did, this stale frame showed through for exactly one frame: the picture jumped backwards
      // and then corrected. Its only job is to cover the gap BEFORE the video paints; after that it
      // is nothing but a stale frame waiting to be revealed.
      style={{ opacity: hidden ? 0 : 1 }}
      onLoad={onPainted}
    />
  )
}

/** The live <video> inside the fly-in clone — held INVISIBLE until it has painted the frame that
 *  was actually clicked.
 *
 *  A fresh <video> does not wait to be seeked before it starts painting. Measured: the clone
 *  paints frame 0 at ~45ms, and its seek to the clicked timestamp only lands at ~106ms. For those
 *  ~60ms the flying clone showed the START of the clip at full opacity, on top of the correct
 *  still, and then cut back — a flash of wrong CONTENT, not animation, which is why it survived
 *  every change to the spring and why slow-mo didn't slow it down. Short loops never show it
 *  (frame 0 is near enough the clicked frame); long clips always did.
 *
 *  FlightStill (the exact clicked frame) is already underneath, so hiding the video until it lands
 *  costs nothing: the swap is then pixel-identical and imperceptible. */
function FlightVideo({ item, videoRef, onShown }: { item: DKLightboxItem; videoRef: { current: HTMLVideoElement | null }; onShown?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [shown, setShown] = useState(false)
  const onShownRef = useRef(onShown)
  useEffect(() => { onShownRef.current = onShown })
  useEffect(() => { if (shown) onShownRef.current?.() }, [shown])

  useEffect(() => {
    const v = ref.current
    if (!v) return
    videoRef.current = v
    type RVFCVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
    const rvfc = (v as RVFCVideo).requestVideoFrameCallback?.bind(v)
    const target = item.videoTime ?? 0
    // Clicked at the very start (or a clip with no captured time): frame 0 IS the right frame.
    let landed = target <= 0
    const onPaint = () => { if (landed) setShown(true); else rvfc?.(onPaint) }
    const onSeeked = () => {
      if (Math.abs(v.currentTime - target) > 0.25) return // an intermediate seek — keep waiting
      landed = true
      if (rvfc) rvfc(onPaint) // reveal on the first frame PAINTED after the seek, not on the event
      else setShown(true) // no rVFC: `seeked` is the best signal available
    }
    v.addEventListener('seeked', onSeeked)
    if (rvfc) rvfc(onPaint)
    else if (landed) setShown(true)
    return () => {
      v.removeEventListener('seeked', onSeeked)
      if (videoRef.current === v) videoRef.current = null
    }
  }, [item.videoTime, videoRef])

  return (
    <video
      ref={ref}
      src={item.videoSrc}
      muted
      playsInline
      loop
      preload="auto"
      onLoadedMetadata={(e) => {
        const v = e.currentTarget
        if (item.videoTime) v.currentTime = item.videoTime
        v.play().catch(() => {})
      }}
      // No transition: this is a cut between identical pixels (the still and the clip's own frame),
      // so a cross-fade would only make it visible.
      style={{ opacity: shown ? 1 : 0 }}
      className="absolute inset-0 z-10 h-full w-full object-contain"
    />
  )
}

export function DKLightbox({ item, index, total, onClose, onPrev, onNext, originRect, prevItem, nextItem, hasCaptions = true, showOutline = true, slowMo = false, getHiResSrc, onFlightPainted }: DKLightboxProps) {
  const caption = item.caption ?? item.alt ?? null

  // Every color routes through the --dk-* tokens (the root below carries .dk-scope, so they
  // resolve here). The two effects that paint OUTSIDE this subtree — the <html>/<body> pin and
  // the theme-color meta — read the resolved literal via getComputedStyle instead.
  const FG = 'var(--dk-fg)'
  const BG = 'var(--dk-bg)'
  const reduceMotion = useReducedMotion()
  const openSpring = slowMo ? SLOW_OPEN_SPRING : OPEN_SPRING

  const rootRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  // The fly-in clone's <video> when the asset is a clip — the modal video reads its LIVE
  // currentTime at handoff so playback continues from wherever the flight actually ended.
  const cloneVideoRef = useRef<HTMLVideoElement>(null)
  // Has the clone's live <video> actually painted? Once it has, the stale still beneath it is
  // dropped (see FlightStill) — it can only do harm from that point on.
  const [cloneVideoShown, setCloneVideoShown] = useState(false)
  // First-real-frame signal for the clone — fired once; the opener hides the origin element
  // on it, so the origin→clone handoff is paint-to-paint with no blink.
  const flightPaintedRef = useRef(false)
  // Also state, because the page-fade loop below must not START until this is true: the page may
  // not begin disappearing before the thing replacing it is on screen.
  const [flightPainted, setFlightPainted] = useState(false)
  const fireFlightPainted = () => {
    if (flightPaintedRef.current) return
    flightPaintedRef.current = true
    setFlightPainted(true)
    onFlightPainted?.()
  }
  const containerRef = useRef<HTMLDivElement>(null)
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null)
  const [animDone, setAnimDone] = useState(!originRect)
  // Hold the spring for ONE painted frame before it starts.
  //
  // motion begins the open animation on the same frame React commits the whole modal — three
  // slides, a <video preload="auto">, and possibly a large data-URL poster to decode. That commit
  // can take ~150ms, so the spring's FIRST rAF arrived with a ~150ms delta and integrated straight
  // to 79% of the travel in a single frame: the clip appeared to snap to full size and then creep
  // the last 20%, with a 4px overshoot correction at the end. Measured off a 60fps screen
  // recording, that is exactly the "jitter right after I click" and the "jitter at the end".
  //
  // Gating on a double-rAF lets the expensive commit land, then starts the spring on a clean
  // frame with a normal ~16ms delta, so it actually springs.
  const [fly, setFly] = useState(false)
  useEffect(() => {
    if (!originRect) return
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setFly(true)))
    return () => cancelAnimationFrame(id)
  }, [originRect])
  const [imageLoaded, setImageLoaded] = useState(false)
  // Images: reveal as soon as the fly-in lands, so the shimmer covers a slow load. Videos:
  // hold the clone — which is the clip itself, still PLAYING — until the modal video has
  // sought to the clone's live position and is painting, so the swap lands on the same frame.
  const containerVisible = !originRect || (animDone && (!item.videoSrc || imageLoaded))
  // Hold the flying clone on screen for two painted frames AFTER the modal is revealed, then drop
  // it. The clone is the same pixels, opaque, frozen, and pointer-events-none, so the overlap is
  // invisible — but the gap it covers is not.
  //
  // Measured in Safari, 60fps: at the handoff there is exactly ONE frame where the whole clip is
  // uniformly washed out (region mean 38.8 -> 67.6 -> 38.1, which solves to the clip at ~87% over
  // the white scrim). Nothing in the tree has an 87% opacity, and it survived making the reveal
  // wait for a painted frame — it is Safari re-compositing the video layer as the clone unmounts
  // and the modal video takes over, during which the new layer is briefly not fully opaque and the
  // scrim shows through it. Chrome never does this.
  //
  // There is no way to make Safari promote the layer faster, so instead nothing is ever uncovered:
  // the clone stays on top across the swap.
  const [cloneGone, setCloneGone] = useState(false)
  useEffect(() => {
    if (!containerVisible || cloneGone) return
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setCloneGone(true)))
    return () => cancelAnimationFrame(id)
  }, [containerVisible, cloneGone])
  // Where the flying-clone open lands: the photo's contain-fitted rect inside the container.
  // Aspect comes from the thumbnail's rect (originRect) — always known, whereas declared
  // width/height may be absent, which would make the fit NaN and the photo never reveal.
  // Reserve the same 10px strip a progress-bar clip leaves at the bottom, so the clone lands
  // exactly where the video ends up (no resize when the bar appears).
  const barReserve = item.videoSrc && item.videoProgress ? 10 : 0
  // Each slide insets its asset 16px per side (inset-x-4 in Slide), so the flight must land
  // inside that same box. Fitting to the full container let a width-bound asset (a landscape
  // photo or clip on a phone) fly to full-bleed and then snap to its real, inset width the
  // moment the track revealed.
  const SLIDE_INSET = 16
  const cloneTarget = targetRect && originRect
    ? containRect(
        {
          left: targetRect.left + SLIDE_INSET,
          top: targetRect.top,
          width: targetRect.width - SLIDE_INSET * 2,
          height: targetRect.height - barReserve,
        },
        originRect.width,
        originRect.height,
      )
    : null

  // Caption/exif follow the committed item but update in step with the slide (not at
  // its end), so they don't appear to lag the image. Re-synced to `item` on prop change.
  const [captionItem, setCaptionItem] = useState(item)
  useEffect(() => { setCaptionItem(item) }, [item])
  const capCaption = captionItem.caption ?? null
  const capExif = formatExif(captionItem.exif)

  // Swipe track: `x` follows the finger horizontally (commit = navigate); `yDrag`
  // follows a downward drag to dismiss. `axis` locks to whichever the finger leads with.
  const x = useMotionValue(0)
  const yDrag = useMotionValue(0)
  const dragOpacity = useTransform(yDrag, [0, 240], [1, 0.2])

  // SWIPE DOWN UNDOES THE OPEN, rather than just sliding the photo away.
  //
  // Opening the overlay fades the page content OUT and the backdrop scrim IN (see the page-fade
  // effect). Dismissing did neither in reverse: the photo slid down and faded, but the scrim stayed
  // fully opaque the whole way, so the page never came back — it simply appeared, all at once, when
  // the modal unmounted. Dragging down now runs the open transition BACKWARDS in step with the
  // finger: the scrim dissolves and the page underneath fades up, so you are literally pulling the
  // page back into view. Let go early and it springs back, taking the reveal with it.
  const siblingsRef = useRef<HTMLElement[]>([])
  const REVEAL_DRAG = 260 // px of downward travel that fully restores the page
  useEffect(() => {
    if (!animDone) return // the open is still running the same properties; don't fight it
    const scrim = scrimRef.current
    const apply = (v: number) => {
      const t = Math.min(1, Math.max(0, v / REVEAL_DRAG))
      if (scrim) scrim.style.opacity = String(1 - t)
      for (const el of siblingsRef.current) el.style.opacity = String(t)
    }
    return yDrag.on('change', apply)
  }, [yDrag, animDone])
  const trackRef = useRef<HTMLDivElement>(null)
  const startX = useRef(0)
  const startY = useRef(0)
  const axis = useRef<null | 'x' | 'y'>(null)
  // Where the gesture crossed the 8px recognition threshold. Movement is measured FROM here, so the
  // asset never jumps to catch up with the finger — it starts under it and stays under it.
  const lock = useRef<{ x: number; y: number } | null>(null)
  const busy = useRef(false)

  useLayoutEffect(() => {
    const body = document.body
    const root = rootRef.current
    const prevOverflow = body.style.overflow
    // Lock scroll. If the host page sets `html { scrollbar-gutter: stable }`, that is deliberately
    // left ALONE: it keeps the ~15px gutter reserved whether or not the scrollbar shows, so nothing
    // shifts when overflow is hidden. The reserved gutter would leave a strip to the right of the
    // modal, so size the modal to the PHYSICAL viewport width: window.innerWidth spans the gutter,
    // whereas 100vw stops short of it when a gutter is reserved. Kept in sync on resize; cleared on
    // close.
    body.style.overflow = 'hidden'
    const fit = () => { if (root) root.style.width = `${window.innerWidth}px` }
    fit()
    window.addEventListener('resize', fit)
    return () => {
      body.style.overflow = prevOverflow
      window.removeEventListener('resize', fit)
      if (root) root.style.width = ''
    }
  }, [])

  // A true modal for the keyboard, not just the eye. aria-modal announces the page as
  // inaccessible but doesn't make it so: Tab still walked the faded-out page underneath (its
  // controls sit at opacity 0 for the Safari toolbar fix — focusable yet fully invisible).
  // `inert` on every other <body> child makes the browser enforce the boundary natively —
  // unfocusable, unclickable, hidden from assistive tech — so Tab cycles the dialog's own
  // controls. Focus moves onto the dialog on open; the opener hands it back to the asset's
  // element on close.
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

  // Chrome/Android and pre-26 Safari tint their toolbar from <meta name="theme-color"> (Safari 26
  // itself ignores it — that case is handled by the <html>/<body> background below). A host site's
  // existing metas may be a prefers-color-scheme pair that (a) doesn't track class dark mode and
  // (b) can out-rank a plain override. While open, remove those and install a single meta pinned to
  // the modal's exact background; restore on close. The literal is read from the resolved --dk-bg
  // (the meta lives outside the .dk-scope subtree, so the var itself can't be used).
  useLayoutEffect(() => {
    const root = rootRef.current
    const bg = root ? getComputedStyle(root).getPropertyValue('--dk-bg').trim() : ''
    if (!bg) return
    const head = document.head
    const saved = Array.from(head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    saved.forEach((el) => el.remove())
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    meta.content = bg
    head.appendChild(meta)
    return () => { meta.remove(); saved.forEach((el) => head.appendChild(el)) }
  }, [])

  // iOS 26 Safari dropped `theme-color` and derives its translucent toolbar tint from the
  // <html>/<body> background-color, so pin BOTH to the modal's exact colour while open — that's
  // what the bar samples. When the host page's background matches --dk-bg (the default pairing),
  // the pin is visually a no-op; either way the toolbar samples the modal's colour. Restored on
  // close. (Same subtlety as the meta: html/body sit outside .dk-scope, so the resolved literal
  // is written, not the var.)
  useLayoutEffect(() => {
    const root = rootRef.current
    const bg = root ? getComputedStyle(root).getPropertyValue('--dk-bg').trim() : ''
    if (!bg) return
    const html = document.documentElement
    const prevBodyBg = document.body.style.backgroundColor
    const prevHtmlBg = html.style.backgroundColor
    document.body.style.backgroundColor = bg
    html.style.backgroundColor = bg
    return () => {
      document.body.style.backgroundColor = prevBodyBg
      html.style.backgroundColor = prevHtmlBg
    }
  }, [])

  // Safari's translucent toolbar blurs the scrolled DOCUMENT beneath it and a fixed overlay does
  // NOT occlude that view — so the page keeps "peering through" the bar no matter how opaque the
  // modal is. The only reliable cure is to take the page content out of the render while open. The
  // modal is portaled to <body>, so fade every OTHER top-level body child to opacity 0 (at 0 it
  // paints nothing → the toolbar is left blurring the bare, modal-coloured <body>). Opacity keeps
  // layout, so there's no reflow or scroll jump. The fade runs on the SAME spring as the open
  // fly-in, so in the toolbar the page dissolves to solid in step with the photo landing rather
  // than cutting out. A deep-link open (no originRect / no fly-in) has nothing to sync to, so it
  // hides instantly. All restored on close; no-ops safely if the modal isn't a direct child of
  // <body>.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || root.parentElement !== document.body) return
    const siblings = Array.from(document.body.children).filter(
      (el): el is HTMLElement =>
        el !== root && el instanceof HTMLElement &&
        el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE' && el.tagName !== 'LINK',
    )
    siblingsRef.current = siblings // the swipe-to-dismiss reveal drives these back in
    // One rAF loop drives the whole open transition on the MAIN THREAD: it fades the page content OUT
    // and the backdrop scrim IN, in step. Why a manual rAF and not a WAAPI/CSS opacity animation:
    // Safari's toolbar samples the MAIN-THREAD paint, so a GPU-composited opacity fade never registers
    // there and the page bleed reads as an instant cut. A per-frame inline-opacity write IS a main-
    // thread paint change, so the page visibly dissolves out of the toolbar. (The scrim only needs to
    // read in the main viewport, but sharing the loop keeps the two perfectly in sync.) A deep-link
    // open (no fly-in) or reduced motion cuts instantly. Cancelling the rAF + clearing inline opacity
    // on close restores everything cleanly — nothing to race with React's dev double-mount.
    const scrim = scrimRef.current
    if (!originRect || reduceMotion) {
      siblings.forEach((el) => { el.style.opacity = '0' })
      return () => { siblings.forEach((el) => { el.style.opacity = '' }) } // scrim stays opaque (instant)
    }
    // THE PAGE MAY NOT START DISAPPEARING BEFORE ITS REPLACEMENT IS ON SCREEN.
    //
    // This was a Safari-only flash right after the click. The loop used to start at mount, so the
    // page began dissolving while the flying clip was still decoding and seeking — and the clicked
    // asset is hidden the moment the clone paints, so for a few frames there was nothing where the
    // asset had been. Measured at 60fps in Safari: the page's text contrast collapsed across two
    // frames (of a 350ms fade!), and the clip did not paint for another three. The screen popped to
    // near-white in the gap. Chrome's commit is fast enough that the same gap is a fraction of a
    // frame, which is why it never showed there.
    //
    // `flightPainted` is fired by the clone's first real painted frame, so gating the loop on it
    // means the replacement is provably visible before anything is taken away.
    //
    // The scrim is hidden HERE, before the gate, and that placement is load-bearing. The scrim's
    // default state is opacity 1 — a full-screen opaque layer over the page. Hiding it inside the
    // gate left it fully opaque for the ~40ms until the clone painted: the entire screen went
    // solid, then the scrim snapped to 0 and eased back in. It must be transparent from the first
    // painted frame; only the LOOP waits.
    if (scrim) scrim.style.opacity = '0' // start transparent; the loop eases it back to 1
    if (!flightPainted) return
    const DURATION = slowMo ? 3000 : 350 // shift-click slow-mo stretches the fade with the spring
    // Integrate CLAMPED deltas rather than reading the wall clock.
    //
    // Safari drops frames through the modal's first commit, so consecutive rAF callbacks can be
    // ~85ms apart. A fade driven by `now - startT` teleports across that gap — which is the other
    // half of why the page vanished in two frames. Capping each step at ~2 frames means a dropped
    // frame costs the fade a little wall time instead of jumping it forward; a stall can never turn
    // the dissolve into a cut.
    let last = 0
    let elapsed = 0
    let raf = 0
    const frame = (now: number) => {
      if (!last) { last = now; raf = requestAnimationFrame(frame); return }
      elapsed += Math.min(now - last, 32)
      last = now
      const t = Math.max(0, Math.min(1, elapsed / DURATION))
      const eased = 1 - (1 - t) ** 3 // ease-out cubic — fast, responsive
      for (const el of siblings) el.style.opacity = String(1 - eased) // page fades OUT
      if (scrim) scrim.style.opacity = String(eased)                  // backdrop fades IN
      if (t < 1) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      for (const el of siblings) el.style.opacity = ''
      if (scrim) scrim.style.opacity = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightPainted])

  useLayoutEffect(() => {
    if (containerRef.current) setTargetRect(containerRef.current.getBoundingClientRect())
  }, [])

  const width = () => containerRef.current?.clientWidth ?? window.innerWidth

  // Nav is ready as soon as the track has been measured (targetRect) — NOT once the whole open
  // fly-in has finished. Gating on the open animation dropped every arrow pressed in its first
  // few hundred ms (longer on a cold/slow load) — presses thrown away. If a press lands
  // before the fly-in ends, commit() snaps it complete so the (now visible) track is what slides.
  const navReadyRef = useRef(false)
  useEffect(() => { navReadyRef.current = !!targetRect }, [targetRect])

  // Index-first navigation. A press commits the new item IMMEDIATELY (so arrows always respond
  // and naturally interrupt an in-flight slide — the press takes priority), then the incoming
  // slide springs home from wherever the track is right now. `x.get() + dir*w` covers every
  // start point in one expression: idle (0), a mid-slide interrupt, or a half-finished finger
  // drag — so the motion is always continuous, never a snap. No queue, no end-of-slide rebase.
  const commit = (dir: 1 | -1, slow = false) => {
    if (!navReadyRef.current) return
    // At a boundary there's no neighbour to reveal — settle any drag/interrupt back to centre.
    if ((dir === 1 && index >= total - 1) || (dir === -1 && index <= 0)) {
      animate(x, 0, SPRING)
      return
    }
    // Pressed before the open fly-in finished: reveal the container now so the slide animates
    // the real track rather than swiping behind the flying clone.
    if (!animDone) flushSync(() => setAnimDone(true))
    const fromX = x.get() + dir * width()
    const target = dir === 1 ? nextItem : prevItem
    x.stop()
    flushSync(() => { if (dir === 1) onNext(); else onPrev() })
    if (target) setCaptionItem(target)
    // Position the just-committed track synchronously (jump + a direct write, same task as the
    // index shift) so the swap lands in one paint with nothing displaced, then spring to centre.
    x.jump(fromX)
    if (trackRef.current) trackRef.current.style.transform = `translateX(${fromX}px)`
    busy.current = true
    animate(x, 0, { ...(slow ? SLOW_NAV_SPRING : reduceMotion ? NAV_SPRING_REDUCED : NAV_SPRING), onComplete: () => { busy.current = false } })
  }

  // Slide the image down and off, then unmount.
  const dismiss = () => {
    animate(yDrag, window.innerHeight, { duration: 0.2, ease: 'easeIn' })
    window.setTimeout(onClose, 190)
  }

  // Arrow keys animate through the same track as swipe / on-screen arrows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); commit(1, e.shiftKey) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); commit(-1, e.shiftKey) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, total])

  const onTouchStart = (e: React.TouchEvent) => {
    if (busy.current) return
    x.stop(); yDrag.stop()
    startX.current = e.touches[0].clientX
    startY.current = e.touches[0].clientY
    axis.current = null
    lock.current = null
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (busy.current) return
    const dx = e.touches[0].clientX - startX.current
    const dy = e.touches[0].clientY - startY.current
    if (axis.current === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      axis.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      // Remember WHERE the axis locked. The 8px the finger travelled to trigger the lock is not
      // drag — it is the gesture being recognised. Feeding the raw delta in meant the photo
      // teleported those 8px the instant the lock fired, and then tracked the finger. That initial
      // jump is what breaks the sense that you are holding the thing: the image should start moving
      // from exactly where your finger is, and stay under it from then on.
      lock.current = { x: dx, y: dy }
    }
    const lx = lock.current?.x ?? 0
    const ly = lock.current?.y ?? 0
    if (axis.current === 'x') {
      const ox = dx - lx
      // Rubber-band when there's no neighbour to reveal.
      const resist = (index <= 0 && ox > 0) || (index >= total - 1 && ox < 0)
      x.set(resist ? ox * 0.35 : ox)
    } else if (axis.current === 'y') {
      yDrag.set(Math.max(0, dy - ly)) // downward only, from the point of lock
    }
  }
  const onTouchEnd = () => {
    const a = axis.current
    axis.current = null
    if (busy.current) return
    if (a === 'x') {
      const dx = x.get()
      const threshold = Math.min(width() * 0.25, 90)
      if (dx <= -threshold) commit(1)
      else if (dx >= threshold) commit(-1)
      else animate(x, 0, SPRING)
    } else if (a === 'y') {
      if (yDrag.get() > CLOSE_DRAG) dismiss()
      else animate(yDrag, 0, SPRING)
    }
    // A tap (no axis lock) falls through to the click handler → close.
  }

  return (
    <m.div
      ref={rootRef}
      // Fixed, full-viewport via left:0 + width (not right:0). `w-screen` is only the pre-JS fallback;
      // the scroll-lock effect sets width to window.innerWidth so the modal also covers a reserved
      // scrollbar gutter (100vw stops short of it) — no bare strip on the right, and without touching
      // the host's `scrollbar-gutter` (dropping that reflows the page under the modal).
      className="dk-scope fixed inset-y-0 left-0 w-screen z-50 flex flex-col select-none overflow-hidden outline-none"
      // Programmatically focusable so focus enters the dialog on open (see the inert effect);
      // -1 keeps it out of the Tab order itself.
      tabIndex={-1}
      // Transparent root; the backdrop is an absolute scrim child that FADES IN (below), so the
      // background eases in instead of snapping opaque on open. (Safari's toolbar is kept solid
      // separately by fading the page content out — see the page-fade effect — since the toolbar
      // blurs the document behind this fixed overlay, not the overlay itself.)
      style={{ color: FG }}
      role="dialog"
      aria-modal="true"
      aria-label={caption ?? 'Photo'}
      onClick={onClose}
    >
      {/* Backdrop scrim — its opacity is eased 0→1 by the page-fade rAF loop (see the effect above),
          so the background fades in together with the page fading out rather than snapping opaque.
          Kept `absolute`, never `fixed` + negative z — that composited ABOVE the photo in Safari and
          hid it. */}
      <div ref={scrimRef} className="absolute inset-0 -z-10" style={{ backgroundColor: BG }} />
      {/* Inner layer carries the swipe-down-to-dismiss transform. */}
      <m.div className="relative flex flex-1 flex-col min-h-0" style={{ y: yDrag, opacity: dragOpacity }}>
      {/* Close — sits above the image; the surrounding layer passes clicks through. */}
      <m.div
        className="absolute inset-0 pointer-events-none z-30"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: !animDone ? 0.25 : 0, duration: 0.2 }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
          aria-label="Close"
          className="pointer-events-auto absolute top-3 right-[14px] flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-[var(--dk-fg)] transition-colors hover:bg-[var(--dk-surface)] active:bg-[var(--dk-surface)]"
        >
          <IconClose />
        </button>
      </m.div>

      {/* Image area — full width so the slide track can carry an asset fully off-screen; the 16px
          side margins live on each slide's inner box (see Slide), not here, so they never clip the
          animation. A slim pt-2 keeps breathing room up top; no bottom padding lets the photo grow
          toward the caption rail. */}
      <div className="flex-1 min-h-0 flex pt-2">
        <div
          ref={containerRef}
          className="flex-1 min-w-0 relative overflow-hidden"
          style={{ opacity: containerVisible ? 1 : 0, touchAction: 'none' }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <m.div ref={trackRef} className="absolute inset-0" style={{ x }}>
            {/* Neighbours do not MOUNT until the open has landed. They are off-screen the whole time
                (translateX ±100%), but mounting them meant React committing two extra <img>/<video>
                trees on the click frame — and that commit is what delayed the spring's first frame.
                They were already deferring their hi-res layer for the same reason; this defers the
                whole slide. Nav still works: commit() flushSync's animDone before it slides. */}
            {prevItem && animDone && <Slide key={prevItem.src} item={prevItem} offset="-100%" hiRes getHiResSrc={getHiResSrc} showOutline={showOutline} />}
            <Slide
              key={item.src}
              item={item}
              offset="0%"
              priority
              // The hi-res layer waits for the landing, exactly as the neighbours' does.
              //
              // The clicked slide used to mount TWO images on the click frame: the base (the
              // origin's already-decoded file — instant, from cache) and a FRESH large fetch on
              // top of it. That second fetch and its decode landed right on the spring's opening
              // frames. Measured in Safari at 60fps: the first two frames of the open took 32ms and
              // 37ms — two missed vsyncs — and every frame after them was a clean 16-17ms. That is
              // the "jitter or two" when opening an image.
              //
              // Nothing is lost by waiting: the base layer is the exact file already on screen, so
              // the flight and the landing look identical either way; the sharp layer just fades in
              // once the animation is out of the way, which is already how every other slide behaves.
              hiRes={animDone}
              getHiResSrc={getHiResSrc}
              showOutline={showOutline}
              armed={animDone}
              onLoad={() => setImageLoaded(true)}
            />
            {nextItem && animDone && <Slide key={nextItem.src} item={nextItem} offset="100%" hiRes getHiResSrc={getHiResSrc} showOutline={showOutline} />}
          </m.div>
        </div>
      </div>

      {/* Single rail — nav + caption + exif on the same surface as the photo, no divider
          (transparent, so the lightbox background shows through as one continuous field), so the
          photo is never obstructed. Clicks here don't close. Prev/next flank a centered caption;
          exif trails on a muted mono line. No counter. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="dk-rail-foot shrink-0 flex items-center gap-3 px-3.5 pt-3"
      >
        {index > 0 ? (
          <button
            onClick={(e) => { e.stopPropagation(); commit(-1, e.shiftKey) }}
            aria-label="Previous photo"
            className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--dk-fg)] transition-colors hover:bg-[var(--dk-surface)] active:bg-[var(--dk-surface)]"
          >
            <IconArrow dir="left" />
          </button>
        ) : (
          <span className="h-11 w-11 shrink-0" />
        )}

        {/* Fixed-height caption well: a 1- vs 2-line caption/exif can't change the rail height
            between photos (which shifted the image and the arrows — the jitter). Mobile reserves
            the 2-line-caption + 2-line-exif worst case; desktop stays compact (matches the arrow
            height). Captions cross-fade (old out / new in) so the swap reads smoothly, not as a pop. */}
        <div className="relative min-w-0 flex-1 min-h-20 md:min-h-11">
          <AnimatePresence initial={false}>
            {hasCaptions && (capCaption || capExif) && (
              <m.div
                key={captionItem.src}
                className="absolute inset-0 flex flex-col justify-center text-center"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22, ease: 'easeInOut' }}
              >
                {capCaption && (
                  <p className="line-clamp-2 font-[family-name:var(--dk-font-sans)] text-[13.5px] leading-snug tracking-normal text-[var(--dk-fg)]">
                    {capCaption}
                  </p>
                )}
                {capExif && (
                  <p className="mt-1 line-clamp-2 font-[family-name:var(--dk-font-mono)] text-[11px] leading-normal text-[var(--dk-muted)]">
                    {capExif}
                  </p>
                )}
              </m.div>
            )}
          </AnimatePresence>
        </div>

        {index < total - 1 ? (
          <button
            onClick={(e) => { e.stopPropagation(); commit(1, e.shiftKey) }}
            aria-label="Next photo"
            className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--dk-fg)] transition-colors hover:bg-[var(--dk-surface)] active:bg-[var(--dk-surface)]"
          >
            <IconArrow dir="right" />
          </button>
        ) : (
          <span className="h-11 w-11 shrink-0" />
        )}
      </div>

      {!cloneGone && cloneTarget && originRect && (
        <m.div
          className="absolute overflow-hidden pointer-events-none"
          // Sits at the photo's final rect; a transform (translate + uniform scale from the
          // thumbnail) does the flight, so only the compositor works — no per-frame layout.
          style={{
            zIndex: 20,
            left: cloneTarget.left,
            top: cloneTarget.top,
            width: cloneTarget.width,
            height: cloneTarget.height,
            transformOrigin: '0 0',
          }}
          initial={{
            x: originRect.left - cloneTarget.left,
            y: originRect.top - cloneTarget.top,
            scaleX: originRect.width / cloneTarget.width,
            scaleY: originRect.height / cloneTarget.height,
          }}
          animate={fly ? { x: 0, y: 0, scaleX: 1, scaleY: 1 } : {
            x: originRect.left - cloneTarget.left,
            y: originRect.top - cloneTarget.top,
            scaleX: originRect.width / cloneTarget.width,
            scaleY: originRect.height / cloneTarget.height,
          }}
          transition={openSpring}
          // Guarded on `fly`: before the gate opens, animate === initial, and motion reports that
          // no-op as "complete". Acting on it would flip animDone, hide the clone, and skip the
          // flight entirely.
          onAnimationComplete={() => { if (fly) flushSync(() => setAnimDone(true)) }}
        >
          {item.videoSrc ? (
            FLY_LIVE_VIDEO ? (
              // The clicked clip KEEPS PLAYING while it flies: a muted clone resumes from the
              // origin's exact frame (videoTime). But a fresh <video> paints NOTHING until it has
              // metadata AND has finished seeking to that frame — and an unpainted <video> is
              // TRANSPARENT (measured in Safari), so the clone was a HOLE that showed the scrim
              // straight through it. Safari also drops `poster` as soon as the video starts
              // loading, so the poster did not cover the gap the way it does in Chrome.
              //
              // Hence the base layer below: the frozen frame ALWAYS paints, and the live <video>
              // sits on top of it and covers it the moment it has a real frame. Playback is
              // preserved; the hole is not possible.
              //
              // Long clips are the ones that show the hole: the clone may seek tens of seconds in,
              // which Safari takes real time to do. Short loops seek almost instantly.
              <>
                <FlightStill item={item} onPainted={fireFlightPainted} hidden={cloneVideoShown} />
                <FlightVideo item={item} videoRef={cloneVideoRef} onShown={() => setCloneVideoShown(true)} />
              </>
            ) : item.flightPoster ? (
              // FLY_LIVE_VIDEO off: fly the FROZEN frame instead of a second live <video>.
              // Same pixels (flightPoster is a canvas snapshot of the exact clicked frame), but
              // no video element is instantiated inside the animating layer. The modal player still
              // lands on the right frame — it starts from item.videoTime regardless — so the clip
              // simply does not advance during the flight.
              <img
                src={item.flightPoster}
                className="absolute inset-0 h-full w-full object-contain"
                alt=""
                aria-hidden
                onLoad={fireFlightPainted}
              />
            ) : null // clip had no decodable frame at click (never loaded) — fly nothing; the
                     // origin simply stays put until the modal player takes over.
          ) : (
            <img
              // flightSrc = the origin's already-decoded file, served verbatim — the clone
              // paints on frame 1 of the flight even on a cold cache. (A fresh differently-sized
              // fetch here often finished loading AFTER the spring, so no fly-in was ever seen.)
              src={item.flightSrc || item.src}
              className="absolute inset-0 h-full w-full object-contain"
              alt=""
              aria-hidden
              onLoad={fireFlightPainted}
            />
          )}
        </m.div>
      )}
      </m.div>
    </m.div>
  )
}

/* ------------------------------------------------------------------------------------------------
 * useDKLightbox — the controller both openers (grid, carousel) drive the lightbox through.
 * Owns: selection state, the click-time capture (origin rect, decoded src, video frame snapshot),
 * keyboard handling (Escape, and the modality tracking that decides whether close restores a
 * focus ring), origin hide/restore, neighbour prefetch, deep links, and the portal itself.
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
  // Suppress the ring for this landing only — BOTH halves of any global :focus-visible recipe
  // the host site may have: an outline AND a box-shadow halo. (An Escape press makes the browser
  // treat the subsequent programmatic focus as :focus-visible, so such a rule fires even for a
  // mouse session; suppressing only the outline leaves a halo showing.) Inline styles win over
  // the rule; lifted the moment focus moves on or the keyboard comes into play.
  const prevOutline = el.style.outline
  const prevShadow = el.style.boxShadow
  const lift = () => {
    el.style.outline = prevOutline
    el.style.boxShadow = prevShadow
    el.removeEventListener('blur', lift)
    window.removeEventListener('keydown', lift)
  }
  el.style.outline = 'none'
  el.style.boxShadow = 'none'
  el.addEventListener('blur', lift, { once: true })
  window.addEventListener('keydown', lift, { once: true })
}

export interface DKLightboxOptions {
  /** A sharper large variant to fade in over the base image (and to prefetch around the current
   *  one). Return item.src (or nothing) to opt an item out. */
  getHiResSrc?: (item: DKMediaItem) => string
  /** Reserve the caption/exif rail. Default: on when any item carries a caption or EXIF. */
  hasCaptions?: boolean
  /** The 1px photo edge outline in the modal. Default true (photographs). */
  showOutline?: boolean
  /** Open from `?photo=<index>` on mount (and strip the param), for shareable deep links. */
  deepLink?: boolean
  /** The on-page element for an item, used to hand focus back on close (and as the deep-link
   *  zoom origin). Wire this to a ref registry of your thumbnails. */
  getOriginEl?: (index: number) => HTMLElement | null
  /** Fired as the modal closes, with the index the viewer was on — e.g. so a carousel can show
   *  the slide they navigated to before focus lands on it. */
  onClose?: (index: number) => void
}

export function useDKLightbox(items: DKMediaItem[], options: DKLightboxOptions = {}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [originRect, setOriginRect] = useState<DOMRect | null>(null)
  const [slowMo, setSlowMo] = useState(false) // shift-click: ~3s slow-motion open for inspection
  const itemsRef = useRef(items)
  useEffect(() => { itemsRef.current = items }, [items])
  const optionsRef = useRef(options)
  useEffect(() => { optionsRef.current = options })
  // The clicked item's runtime capture (decoded src / video frame), keyed to its index.
  const captureRef = useRef<{ index: number; data: Partial<DKLightboxItem> } | null>(null)
  const prefetchedHiRes = useRef<Set<string>>(new Set())
  // Videos elsewhere in the opener's scope, paused while the overlay is open — otherwise they
  // keep playing behind the fading-in backdrop and flash as "remnants". Resumed on close.
  const pausedRef = useRef<HTMLVideoElement[]>([])
  // The clicked element — hidden while open so it doesn't sit under the fly-in clone (the clone
  // IS that asset moving into the modal). visibility keeps its layout slot, so nothing reflows.
  const originElRef = useRef<HTMLElement | null>(null)
  // The last item shown, surviving close's setSelectedIndex(null) — close hands focus back to
  // ITS element (not the entry one; the viewer may have arrowed far from where they came in).
  const latestIndexRef = useRef<number | null>(null)
  useEffect(() => {
    if (selectedIndex !== null) latestIndexRef.current = selectedIndex
  }, [selectedIndex])
  // Did this session show REAL keyboard navigation (keyboard-activated open, or a Tab while
  // open)? Only then does the restored thumbnail show its focus ring. Escape/arrows don't
  // count — mouse users press those too, and the browser's own focus-visible heuristic
  // flashing a ring after a mouse session + Escape is exactly the misfire this replaces.
  const keyboardModeRef = useRef(false)
  useEffect(() => {
    if (selectedIndex === null) return
    const onTab = (e: KeyboardEvent) => {
      if (e.key === 'Tab') keyboardModeRef.current = true
    }
    window.addEventListener('keydown', onTab)
    return () => window.removeEventListener('keydown', onTab)
  }, [selectedIndex])

  const close = useCallback(() => {
    setSelectedIndex(null)
    setOriginRect(null)
    if (originElRef.current) { originElRef.current.style.visibility = ''; originElRef.current = null }
    pausedRef.current.forEach((v) => v.play().catch(() => {}))
    pausedRef.current = []
    const idx = latestIndexRef.current
    if (idx !== null) optionsRef.current.onClose?.(idx)
    // Hand focus back to the element of the item the viewer closed ON (they may have navigated
    // far from the one they entered through) — the APG dialog pattern, so a keyboard user
    // resumes tabbing from where they left the page instead of from the top.
    // Deferred a frame: at this point the modal is still mounted, so the page is still `inert` —
    // and focusing an inert element is a silent no-op. One rAF later the dialog has unmounted and
    // its cleanup has lifted inert, so the focus actually takes.
    const withRing = keyboardModeRef.current
    requestAnimationFrame(() => {
      const el = idx !== null ? optionsRef.current.getOriginEl?.(idx) ?? null : null
      if (el) {
        restoreFocus(el, withRing)
      } else if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    })
  }, [])
  const prev = useCallback(() => {
    setSelectedIndex((i) => (i !== null && i > 0 ? i - 1 : i))
  }, [])
  const next = useCallback(() => {
    setSelectedIndex((i) => {
      const len = itemsRef.current.length
      return i !== null && i < len - 1 ? i + 1 : i
    })
  }, [])

  useEffect(() => {
    if (selectedIndex === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIndex, close])

  /** Open the lightbox on `items[index]`, flying in from `el` (the clicked thumbnail/slide).
   *  Pass the click event (or its shiftKey/detail) so slow-mo and keyboard modality register. */
  const open = useCallback((index: number, el?: HTMLElement | null, e?: { shiftKey?: boolean; detail?: number }) => {
    const item = itemsRef.current[index]
    if (!item) return
    setSlowMo(!!e?.shiftKey)
    // A keyboard-activated button fires click with detail 0 — that's a keyboard open.
    keyboardModeRef.current = (e?.detail ?? 1) === 0
    const data: Partial<DKLightboxItem> = {}
    if (el) {
      setOriginRect(el.getBoundingClientRect())
      // Hidden on the lightbox's onFlightPainted signal (below), not at click, so the origin
      // never blinks out before its flying copy has painted.
      originElRef.current = el
      const video = el.querySelector('video') ?? (el instanceof HTMLVideoElement ? el : null)
      if (item.videoSrc && video) {
        // The fly-in clone resumes playing from this exact frame.
        data.videoTime = video.currentTime || 0
        // Freeze the exact on-screen frame as a data-URL poster for the fly-in clone. A brand-new
        // <video> needs metadata + a seek before it paints ANYTHING, and during that ~100-500ms gap
        // the page fade was already dimming the origin — the clip visibly blinked out, then
        // reappeared. The canvas snapshot paints with the clone's first commit instead. Same-origin
        // clips only; a tainted canvas just skips the poster and falls back to the paint signal.
        // ONLY the clicked clip: this is a synchronous drawImage + toDataURL JPEG encode (~15ms)
        // inside the click handler — doing it for every clip on a page blocked the main thread long
        // enough to eat the open spring's first frames.
        try {
          if (video.readyState >= 2 && video.videoWidth) {
            const c = document.createElement('canvas')
            c.width = video.videoWidth
            c.height = video.videoHeight
            c.getContext('2d')?.drawImage(video, 0, 0)
            data.flightPoster = c.toDataURL('image/jpeg', 0.85)
          }
        } catch { /* cross-origin frame — no poster */ }
        // Freeze other playing clips in this opener's scope during the open.
        const scope = el.closest('[data-dk-scope]') ?? document
        const playing = Array.from(scope.querySelectorAll<HTMLVideoElement>('video')).filter((v) => !v.paused)
        playing.forEach((v) => v.pause())
        pausedRef.current = playing
      } else {
        // The exact file the origin <img> already decoded — the lightbox reuses it verbatim so
        // the fly-in and the slide's base layer paint instantly from cache, instead of
        // re-fetching at a fresh size (the cold-start "modal first, image later" gap).
        const img = el.querySelector('img')
        data.flightSrc = img?.currentSrc || undefined
      }
    } else {
      setOriginRect(null)
    }
    captureRef.current = { index, data }
    setSelectedIndex(index)
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

  // While an item is open, warm the hi-res variant of nearby items so navigation is instant and
  // always sharp — next first, then +2, +3, then the previous one. Held off ~500ms so these
  // background loads land AFTER the open/nav animation, not during it (five big images decoding
  // at once jitters the spring). The timeout is cleared on fast re-navigation, so we only warm
  // around where the viewer actually settles.
  useEffect(() => {
    if (selectedIndex === null) return
    const getHiResSrc = optionsRef.current.getHiResSrc
    if (!getHiResSrc) return
    const t = window.setTimeout(() => {
      const all = itemsRef.current
      for (const i of [selectedIndex + 1, selectedIndex + 2, selectedIndex + 3, selectedIndex - 1]) {
        const p = all[i]
        if (!p || p.videoSrc) continue
        const hi = getHiResSrc(p)
        if (!hi || hi === p.src || prefetchedHiRes.current.has(hi)) continue
        prefetchedHiRes.current.add(hi)
        const img = new window.Image()
        img.src = hi
      }
    }, 500)
    return () => window.clearTimeout(t)
  }, [selectedIndex])

  const toLightboxItem = useCallback((i: number): DKLightboxItem => {
    const base = itemsRef.current[i]
    const cap = captureRef.current
    return {
      ...base,
      // Package default: clips in the modal get the 2px accent progress bar.
      videoProgress: !!base.videoSrc,
      ...(cap && cap.index === i ? cap.data : null),
    }
  }, [])

  const selected = selectedIndex !== null ? items[selectedIndex] : null
  const hasCaptions =
    options.hasCaptions ?? items.some((p) => p.caption || formatExif(p.exif))

  const lightbox = selected && selectedIndex !== null
    ? createPortal(
        // Portaled to <body> (not rendered inline) so it's a sibling of the page content: the
        // lightbox inerts + hides those siblings while open (Safari toolbar fix + real modality).
        // The package ships its own LazyMotion so `m` components work without host setup.
        <LazyMotion features={domAnimation}>
          <DKLightbox
            item={toLightboxItem(selectedIndex)}
            index={selectedIndex}
            total={items.length}
            onClose={close}
            onPrev={prev}
            onNext={next}
            originRect={originRect}
            slowMo={slowMo}
            hasCaptions={hasCaptions}
            showOutline={options.showOutline ?? true}
            getHiResSrc={options.getHiResSrc}
            onFlightPainted={() => {
              if (originElRef.current) originElRef.current.style.visibility = 'hidden'
            }}
            prevItem={selectedIndex > 0 ? toLightboxItem(selectedIndex - 1) : null}
            nextItem={selectedIndex < items.length - 1 ? toLightboxItem(selectedIndex + 1) : null}
          />
        </LazyMotion>,
        document.body,
      )
    : null

  return { open, close, isOpen: selectedIndex !== null, activeIndex: selectedIndex, lightbox }
}
