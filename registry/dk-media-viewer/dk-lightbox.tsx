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
/* The veil (the in-document layer the iOS bottom bar blurs — see the backdrop effect) never
 * goes below THIS opacity while mounted: at exactly 0 an element paints nothing and Safari
 * tears its layers down, and rebuilding is the lazy path that popped instead of fading. */
const VEIL_MIN_OPACITY = 0.002

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
  /** Fired ONCE, when the open has fully settled (the flying clone has been dropped and the
   *  modal owns the screen). The opener RESTORES the hidden origin element on this signal —
   *  the modal covers it completely, and having it back means a later swipe-down reveals the
   *  asset you tapped instead of a blank hole in the page. */
  onSettled?: () => void
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
function LightboxVideo({ item, priority, onLoad, armed = true, getCloneTime }: {
  item: DKLightboxItem
  priority?: boolean
  onLoad?: () => void
  armed?: boolean
  /** The playhead of the frame the flying clone is CURRENTLY showing — its live video's time
   *  when that has painted, else the frozen poster's captured time. The reveal syncs to this,
   *  because this clip plays behind the veil while it loads and drifts away from the clone. */
  getCloneTime?: () => number | null
}) {
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
  const getCloneTimeRef = useRef(getCloneTime)
  useEffect(() => { getCloneTimeRef.current = getCloneTime })
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
    // COLD-CACHE GUARD: the reveal may not run until the seek to the clicked frame has LANDED.
    //
    // Setting currentTime updates the property immediately but seeks asynchronously — and on a
    // cold cache a seek deep into the file has to fetch and decode a distant byte range, which
    // takes long enough that requestVideoFrameCallback fires first with frame 0 still on screen.
    // The reveal then dropped the clone (showing the correct clicked frame) over a modal video
    // showing the START of the clip: the picture jumped backwards at the end of the fly-in, then
    // jumped again when the seek landed. Warm caches seek instantly, which is why it only ever
    // showed cold. FlightVideo has always gated on the landed seek; this is the same gate.
    let seekTarget = priority && item.videoTime ? item.videoTime : 0
    let seekLanded = seekTarget <= 0
    let seekFailsafe: number | undefined
    let resyncs = 0
    const startPlayback = () => {
      if (started) return
      started = true
      // Match the clone's starting frame. Only the clicked clip (priority) does this; neighbours
      // rest at frame 0 until they are swiped to.
      if (priority && item.videoTime && v.currentTime < 0.05) {
        try {
          v.currentTime = item.videoTime
          // If `seeked` somehow never fires (a stream that can't land it), reveal anyway after
          // 4s — the clone (the clip itself, playing) covers the whole wait, so the failsafe
          // only trades a permanently-hidden modal video for a worst-case late swap.
          seekFailsafe = window.setTimeout(() => { seekLanded = true; maybeReveal() }, 4000)
        } catch {
          seekLanded = true // not seekable yet — plays from 0; nothing better to wait for
        }
      } else {
        seekLanded = true // no seek needed: the current frame is already the right frame
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
    // The single reveal funnel: seek landed AND flight landed (armed) AND in step with the
    // clone, else park in pending. `revealRef` points HERE (not at revealOnPaintedFrame), so
    // the armed-flip re-fire runs the same gates — it used to jump straight to the paint wait,
    // which skipped the sync check below.
    const maybeReveal = () => {
      if (revealed || !seekLanded) return
      // The flight has not landed yet: keep this clip playing BEHIND the clone (the container is
      // still transparent) and reveal the moment `armed` flips.
      if (!armedRef.current) { pendingRef.current = true; return }
      // FINAL SYNC. "Both start from the clicked frame and play at 1x, so they stay together"
      // is only true when both START at the same wall-clock moment. On a slow load this clip
      // begins playing whenever its data arrives — behind the veil — while the clone has been
      // showing the clicked frame (frozen poster) or its own live playback the whole time. By
      // reveal time the two could be seconds apart, and the swap jumped: THE flash at the end
      // of the open that survived the seek gate. So immediately before revealing, compare
      // against the frame the clone is actually showing and land there first. Each pass loops
      // back through `seeked` → here; three attempts is plenty (warm seeks converge in one).
      const cloneT = priority ? getCloneTimeRef.current?.() : null
      if (cloneT != null && Math.abs(v.currentTime - cloneT) > 0.15 && resyncs < 3) {
        resyncs++
        seekLanded = false
        seekTarget = Math.max(0, Math.min(cloneT + 0.05, (Number.isFinite(v.duration) ? v.duration : Infinity) - 0.05))
        try { v.currentTime = seekTarget } catch { seekLanded = true }
        return
      }
      revealOnPaintedFrame()
    }
    revealRef.current = maybeReveal
    const onSeeked = () => {
      if (Math.abs(v.currentTime - seekTarget) > 0.25) return // an intermediate seek — keep waiting
      window.clearTimeout(seekFailsafe)
      seekLanded = true
      maybeReveal()
    }
    const onReady = () => {
      measure()
      startPlayback() // in sync with the clone, from the first moment it can be
      maybeReveal()
    }
    v.addEventListener('seeked', onSeeked)
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
      window.clearTimeout(seekFailsafe)
      v.removeEventListener('seeked', onSeeked)
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
function Slide({ item, offset, priority, hiRes = true, getHiResSrc, onLoad, showOutline = true, armed = true, getCloneTime }: {
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
  /** See LightboxVideo — the clone's currently-visible playhead, for the reveal-time sync. */
  getCloneTime?: () => number | null
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
          <LightboxVideo item={item} priority={priority} onLoad={onLoad} armed={armed} getCloneTime={getCloneTime} />
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
function FlightStill({ item, onPainted, hidden = false, repaintRef }: {
  item: DKLightboxItem
  onPainted: () => void
  hidden?: boolean
  /** Parent-held hook: repaint this still from the live clone <video>, so it can come BACK at
   *  the handoff showing the current frame instead of the stale click frame (see below). */
  repaintRef?: { current: ((v: HTMLVideoElement) => void) | null }
}) {
  // A CANVAS rather than an <img>, so its pixels can be refreshed. The still starts as the
  // click-frame snapshot (flightPoster) and its only job used to end the moment the live video
  // painted — it went to opacity 0 and stayed there, because Safari transiently drops video
  // layers while re-compositing and this STALE frame showing through read as the picture
  // jumping backwards. But hiding it opened a worse hole: at the handoff re-composite (modal
  // container promoted, clone eventually dropped) a transiently-dropped video layer now had
  // NOTHING beneath it but the scrim — the intermittent WHITE flash at the end of the open.
  // The parent now repaints this canvas from the clone's live frame right before the handoff
  // and un-hides it, so every re-composite window has current pixels underneath.
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const src = item.flightPoster || item.src
  const onPaintedRef = useRef(onPainted)
  useEffect(() => { onPaintedRef.current = onPainted })
  useEffect(() => {
    if (!src) return
    const img = new window.Image()
    img.onload = () => {
      const c = canvasRef.current
      if (!c) return
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      c.getContext('2d')?.drawImage(img, 0, 0)
      onPaintedRef.current()
    }
    img.src = src
  }, [src])
  useEffect(() => {
    if (!repaintRef) return
    repaintRef.current = (v: HTMLVideoElement) => {
      const c = canvasRef.current
      if (!c || !v.videoWidth) return
      if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight }
      try { c.getContext('2d')?.drawImage(v, 0, 0) } catch { /* cross-origin frame — keep poster */ }
    }
    return () => { repaintRef.current = null }
  }, [repaintRef])
  if (!src) return null
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="absolute inset-0 h-full w-full object-contain"
      style={{ opacity: hidden ? 0 : 1 }}
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

export function DKLightbox({ item, index, total, onClose, onPrev, onNext, originRect, prevItem, nextItem, hasCaptions = true, showOutline = true, slowMo = false, getHiResSrc, onFlightPainted, onSettled }: DKLightboxProps) {
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
  // Ref mirror for getCloneTime, which is read from inside LightboxVideo's long-lived effect.
  const cloneVideoShownRef = useRef(false)
  useEffect(() => { cloneVideoShownRef.current = cloneVideoShown }, [cloneVideoShown])
  // The playhead of the frame the CLONE is currently showing: its live video's time once that
  // has painted, else the frozen poster's captured time. The modal clip syncs to this right
  // before it reveals (see the FINAL SYNC note in LightboxVideo).
  const getCloneTime = useCallback(() => {
    const cv = cloneVideoRef.current
    if (cv && cloneVideoShownRef.current) return cv.currentTime
    return item.videoTime ?? 0
  }, [item.videoTime])
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
  const cloneGoneRef = useRef(false)
  const onSettledRef = useRef(onSettled)
  useEffect(() => { onSettledRef.current = onSettled })
  // Hide the clone (it stays MOUNTED — see the render note) and declare the open settled.
  // Shared by the overlap timer below and commit(), which must drop the clone instantly when a
  // nav starts sliding the track underneath it.
  const settleClone = useCallback(() => {
    if (cloneGoneRef.current) return
    cloneGoneRef.current = true
    setCloneGone(true)
    // The clone's job is over; its video needn't keep decoding in parallel with the modal's.
    cloneVideoRef.current?.pause()
    // The open has fully settled: the modal owns the screen. The opener restores the hidden
    // origin element on this signal (see DKLightboxProps.onSettled).
    onSettledRef.current?.()
  }, [])
  // The overlap grew from two painted frames to 300ms. Two frames covered Chrome, but Safari's
  // transient layer washout at the handoff (see below) can outlive them — and since the clone
  // and the modal are frame-locked by reveal time (see LightboxVideo's FINAL SYNC), a longer
  // overlap is invisible. It ends EARLY the moment a nav needs the track (commit calls
  // settleClone), so interaction never fights it.
  useEffect(() => {
    if (!containerVisible || cloneGone) return
    // 300ms ONLY for clips (the Safari video-layer washout the overlap exists for; clone and
    // modal are frame-locked so it's invisible). Images get the original two-frames-worth:
    // an image clone fits by the THUMBNAIL's aspect, and when that differs a hair from the
    // slide's intrinsic-aspect letterbox, a long overlap shows two sizes stacked.
    const id = window.setTimeout(settleClone, item.videoSrc ? 300 : 35)
    return () => window.clearTimeout(id)
  }, [containerVisible, cloneGone, settleClone])
  // At the moment of the handoff, refresh the still UNDER the clone's video with the clone's
  // current frame and bring it back (FlightStill was hidden once the live video painted). Every
  // layer Safari might transiently drop during the handoff re-composite now has current pixels
  // beneath it instead of the white scrim.
  const stillRepaintRef = useRef<((v: HTMLVideoElement) => void) | null>(null)
  const [stillResurfaced, setStillResurfaced] = useState(false)
  useEffect(() => {
    if (!containerVisible || stillResurfaced) return
    const cv = cloneVideoRef.current
    if (cv) stillRepaintRef.current?.(cv)
    setStillResurfaced(true)
  }, [containerVisible, stillResurfaced])
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
  // Fades to FULLY transparent by 280px: the release animation only needs to travel far
  // enough for the content to dissolve, not escort it to the bottom of the screen.
  const dragOpacity = useTransform(yDrag, [0, 280], [1, 0])

  // SWIPE DOWN UNDOES THE OPEN, rather than just sliding the photo away.
  //
  // Opening the overlay fades the page content OUT and the backdrop scrim IN (see the page-fade
  // effect). Dismissing did neither in reverse: the photo slid down and faded, but the scrim stayed
  // fully opaque the whole way, so the page never came back — it simply appeared, all at once, when
  // the modal unmounted. Dragging down now runs the open transition BACKWARDS in step with the
  // finger: the scrim dissolves and the page underneath fades up, so you are literally pulling the
  // page back into view. Let go early and it springs back, taking the reveal with it.
  // The in-document veil the iOS bottom bar actually blurs — created by the backdrop
  // effect below; the swipe-down reveal drives its opacity back out.
  const veilRef = useRef<HTMLDivElement | null>(null)
  const REVEAL_DRAG = 260 // px of downward travel that fully restores the page
  // The open page-fade's rAF id, so a downward drag can take the opacity channel over from it
  // (see below). Written every frame by the page-fade loop.
  const openFadeRafRef = useRef(0)
  useEffect(() => {
    // NOT gated on animDone. It used to be ("the open is still running the same properties;
    // don't fight it") — but on a phone the common gesture is tap, then swipe down immediately,
    // BEFORE the ~350ms fly-in lands. With the subscription not yet made, the drag moved the
    // photo while the page stayed frozen at whatever opacity the open fade had reached, then
    // snapped visible when the modal unmounted — "it just instantly reappears". The fight is
    // resolved the other way now: at rest (v=0) this never writes, and the moment a real drag
    // begins it CANCELS the open fade's rAF loop and owns the opacity channel from there.
    const scrim = scrimRef.current
    const apply = (v: number) => {
      if (v <= 0) return // at rest: leave the open fade alone
      cancelAnimationFrame(openFadeRafRef.current)
      const t = Math.min(1, Math.max(0, v / REVEAL_DRAG))
      if (scrim) scrim.style.opacity = String(1 - t)
      // The veil — the in-document layer the iOS bottom bar blurs — tracks the scrim exactly,
      // so the strip behind the bar fades with the finger like the rest of the modal.
      if (veilRef.current) veilRef.current.style.opacity = String(Math.max(VEIL_MIN_OPACITY, 1 - t))
    }
    return yDrag.on('change', apply)
  }, [yDrag])
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

  // Safari's translucent bottom bar blurs the scrolled DOCUMENT beneath it, and a fixed
  // overlay does NOT occlude that view — so no matter how opaque the modal was, the page kept
  // peering through the bar. The cure used to be fading every other <body> child to ~0 and
  // letting the bar blur the bare modal-coloured body. That held until the swipe-down reveal
  // exposed its weakness: the bar rebuilds its blur of REAPPEARING in-document content
  // LAZILY (~1s), so the strip behind it sat as a flat modal-coloured box and popped late —
  // while a tap-close (instant unmount) updated instantly. Warm-layer opacity floors and
  // post-teardown repaint nudges did not move it; reappearing content is simply the slow path.
  //
  // So nothing reappears anymore. The page stays at FULL opacity the whole time, and a VEIL —
  // an absolutely-positioned in-document element (NOT fixed, so the bar provably samples it)
  // covering the viewport behind the modal — carries the modal colour instead. The open fades
  // the veil IN over the unchanged page (perceived content visibility is (1-eased)² either
  // way — scrim over veil now, scrim over fading page before — so the look is identical), and
  // the swipe-down reveal fades it OUT: a DISAPPEARING in-document layer, the direction the
  // bar's backdrop handles live. A tap-close removes it with the unmount, which was already
  // instant. The veil floors at VEIL_MIN_OPACITY so its layer never tears down mid-session.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || root.parentElement !== document.body) return
    const scrim = scrimRef.current
    const veil = document.createElement('div')
    veil.setAttribute('aria-hidden', 'true')
    // Viewport-covering with 200px of slack both ends (bar geometry, rubber-banding, rotation
    // mid-gesture); re-fitted on resize. Scroll is locked while open, so top stays valid.
    const fitVeil = () => {
      veil.style.top = `${window.scrollY - 200}px`
      veil.style.height = `${window.innerHeight + 400}px`
    }
    Object.assign(veil.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      // Under the modal (z-50), above everything the page stacks (the header is 45).
      zIndex: '49',
      pointerEvents: 'none',
      // The scrim's own resolved colour — the veil is the scrim's in-document twin.
      backgroundColor: scrim ? getComputedStyle(scrim).backgroundColor : '#fff',
      opacity: !originRect || reduceMotion ? '1' : String(VEIL_MIN_OPACITY),
    })
    fitVeil()
    window.addEventListener('resize', fitVeil)
    document.body.appendChild(veil)
    veilRef.current = veil
    return () => {
      window.removeEventListener('resize', fitVeil)
      veil.remove()
      veilRef.current = null
      // Belt and suspenders for any straggler blur the bar still holds after teardown: two
      // frames later (after the opener's exact scroll restore), move the page 1px and put it
      // back — the backdrop provably tracks scroll.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const sy = window.scrollY
        window.scrollTo(window.scrollX, sy > 0 ? sy - 1 : sy + 1)
        requestAnimationFrame(() => window.scrollTo(window.scrollX, sy))
      }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The open transition: one main-thread rAF loop fades the scrim and the veil in together.
  // Main-thread inline writes, not WAAPI/CSS: the bar samples the main-thread paint, so a
  // composited fade would read there as a cut. Deep-link opens and reduced motion skip the
  // loop entirely (the veil mounted at 1, the scrim keeps its default opaque state).
  useLayoutEffect(() => {
    if (!originRect || reduceMotion) return
    const scrim = scrimRef.current
    const veil = veilRef.current
    // THE PAGE MAY NOT START DISAPPEARING BEFORE ITS REPLACEMENT IS ON SCREEN: the loop is
    // gated on the clone's first painted frame (flightPainted). The scrim, whose default
    // state is opaque, is made transparent HERE — before the gate — or the whole screen goes
    // solid for the ~40ms until the clone paints. That placement is load-bearing.
    if (scrim) scrim.style.opacity = '0' // start transparent; the loop eases it back to 1
    if (!flightPainted) return
    const DURATION = slowMo ? 3000 : 350 // shift-click slow-mo stretches the fade with the spring
    // Integrate CLAMPED deltas rather than reading the wall clock: Safari drops frames through
    // the modal's first commit, and a wall-clock fade teleports across the gap — a stall can
    // never turn this dissolve into a cut.
    let last = 0
    let elapsed = 0
    const frame = (now: number) => {
      if (!last) { last = now; openFadeRafRef.current = requestAnimationFrame(frame); return }
      elapsed += Math.min(now - last, 32)
      last = now
      const t = Math.max(0, Math.min(1, elapsed / DURATION))
      const eased = 1 - (1 - t) ** 3 // ease-out cubic — fast, responsive
      if (veil) veil.style.opacity = String(Math.max(VEIL_MIN_OPACITY, eased)) // the bar's white rises
      if (scrim) scrim.style.opacity = String(eased)                          // the viewport's white, same curve
      if (t < 1) openFadeRafRef.current = requestAnimationFrame(frame)
    }
    // The id lives in openFadeRafRef (not a local) so the swipe-down reveal can cancel this
    // loop the moment a drag starts and own the opacity channel mid-open.
    openFadeRafRef.current = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(openFadeRafRef.current)
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
    // The nav is about to slide the track: the (possibly still-overlapping) stationary clone
    // must not sit on top of it. Ends the 300ms handoff overlap early.
    settleClone()
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
    // A SHORT drop, not a ride to the bottom of the screen: the content is fully transparent
    // by 280px of travel (dragOpacity), so animating to window.innerHeight just meant watching
    // nothing move for most of the duration. Drop a further ~200px from wherever the finger
    // let go — always past both the fade end and the page-restore distance (REVEAL_DRAG), so
    // the dissolve completes and the page beneath is fully back before the unmount.
    const target = Math.max(REVEAL_DRAG + 60, yDrag.get() + 200)
    animate(yDrag, target, { duration: 0.16, ease: 'easeIn' })
    window.setTimeout(onClose, 150)
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
      // A recognized gesture is about to move the media out from under the (possibly
      // still-overlapping) stationary clone — end the handoff overlap now.
      settleClone()
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
      {/* The swipe used to translate THIS whole layer — chrome included. The drag now lives
          on the media area alone (and the rail fades in place): the close button and arrows
          hold still while the photo is pulled away (Dave's call, 2026-07-24). */}
      <div className="relative flex flex-1 flex-col min-h-0">
      {/* Close — sits above the image; the surrounding layer passes clicks through. */}
      <m.div
        className="absolute inset-0 pointer-events-none z-30"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: !animDone ? 0.25 : 0, duration: 0.2 }}
      >
        {/* Fades with the drag but does NOT move. It was the last opaque thing on the modal
            at unmount, and iOS 26's bottom-bar backdrop cache held a snapshot of it (plus the
            modal's white field) for ~a second after a swipe dismiss — a ghost close button.
            Fully-faded chrome means any stale snapshot is of nothing. The outer overlay owns
            the entrance opacity, so the drag binding needs its own layer. */}
        <m.div className="absolute inset-0" style={{ opacity: dragOpacity }}>
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
          aria-label="Close"
          className="pointer-events-auto absolute top-3 right-[14px] flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-[var(--dk-fg)] transition-colors hover:bg-[var(--dk-surface)] active:bg-[var(--dk-surface)]"
        >
          <IconClose />
        </button>
        </m.div>
      </m.div>

      {/* Image area — full width so the slide track can carry an asset fully off-screen; the 16px
          side margins live on each slide's inner box (see Slide), not here, so they never clip the
          animation. A slim pt-2 keeps breathing room up top; no bottom padding lets the photo grow
          toward the caption rail. */}
      <m.div className="flex-1 min-h-0 flex pt-2" style={{ y: yDrag, opacity: dragOpacity }}>
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
              getCloneTime={getCloneTime}
              onLoad={() => setImageLoaded(true)}
            />
            {nextItem && animDone && <Slide key={nextItem.src} item={nextItem} offset="100%" hiRes getHiResSrc={getHiResSrc} showOutline={showOutline} />}
          </m.div>
        </div>
      </m.div>

      {/* Single rail — nav + caption + exif on the same surface as the photo, no divider
          (transparent, so the lightbox background shows through as one continuous field), so the
          photo is never obstructed. Clicks here don't close. Prev/next flank a centered caption;
          exif trails on a muted mono line. No counter. */}
      <m.div
        onClick={(e) => e.stopPropagation()}
        // Fades with the drag but does NOT move — only the media travels.
        style={{ opacity: dragOpacity }}
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
      </m.div>

      {cloneTarget && originRect && (
        <m.div
          className="absolute overflow-hidden pointer-events-none"
          // Sits at the photo's final rect; a transform (translate + uniform scale from the
          // thumbnail) does the flight, so only the compositor works — no per-frame layout.
          //
          // The clone STAYS MOUNTED at opacity 0 after the handoff instead of unmounting.
          // Unmounting it forced Safari to tear down and re-composite the layer tree at the
          // exact moment the modal video's fresh layer was still being promoted — the transient
          // "not fully opaque" washout that read as a white flash at the end of the open. An
          // opacity flip destroys nothing; the whole subtree simply leaves with the modal.
          style={{
            zIndex: 20,
            left: cloneTarget.left,
            top: cloneTarget.top,
            width: cloneTarget.width,
            height: cloneTarget.height,
            transformOrigin: '0 0',
            opacity: cloneGone ? 0 : 1,
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
                <FlightStill
                  item={item}
                  onPainted={fireFlightPainted}
                  // Hidden while the live video flies (its click frame goes stale within
                  // frames), then resurfaced with FRESH pixels for the handoff window.
                  hidden={cloneVideoShown && !stillResurfaced}
                  repaintRef={stillRepaintRef}
                />
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
      </div>
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
  // The page's scroll position at open. Close restores it EXACTLY: traversing the modal must not
  // move the reader — restoreFocus's scrollIntoView on the closed-on element was relocating the
  // page after a few swipes.
  const scrollPosRef = useRef<{ x: number; y: number } | null>(null)
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
    const pos = scrollPosRef.current
    scrollPosRef.current = null
    requestAnimationFrame(() => {
      const el = idx !== null ? optionsRef.current.getOriginEl?.(idx) ?? null : null
      if (el) {
        restoreFocus(el, withRing)
      } else if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
      // AFTER restoreFocus (whose scrollIntoView may have moved the page toward the closed-on
      // element): put the reader back precisely where they were when they opened the modal.
      // Same task, so only the final position ever paints.
      if (pos) window.scrollTo(pos.x, pos.y)
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
    scrollPosRef.current = { x: window.scrollX, y: window.scrollY }
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
            onSettled={() => {
              // The modal fully covers the page now — put the tapped element back so a
              // swipe-down dismiss reveals it instead of a blank hole. close() re-clearing
              // visibility is a harmless no-op.
              if (originElRef.current) originElRef.current.style.visibility = ''
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
