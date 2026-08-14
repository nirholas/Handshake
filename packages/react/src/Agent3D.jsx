import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';

const DEFAULT_BASE_URL = 'https://three.ws';

/** Coerce a width/height prop (number → px, string passed through). */
function toCssSize(value) {
  if (value == null) return undefined;
  return typeof value === 'number' ? `${value}px` : value;
}

/**
 * Build the embed player URL from props using URL + searchParams (never string
 * concat). Maps 1:1 to the params accepted by https://three.ws/walk-embed.
 */
function buildEmbedSrc({
  baseUrl,
  agentId,
  avatarId,
  controls,
  background,
  environment,
  autoplay,
  ground,
  orbit,
}) {
  const url = new URL('/walk-embed', baseUrl);
  const p = url.searchParams;

  // avatarId overrides the agent's default avatar; otherwise the agent id is the avatar.
  const avatar = avatarId || agentId;
  if (avatar) p.set('avatar', avatar);
  if (controls) p.set('controls', controls);
  if (background) p.set('bg', background);
  if (environment) p.set('env', environment);
  if (autoplay) p.set('autoplay', 'true');
  // Player defaults ground/orbit to ON; only emit the param to turn them off.
  if (ground === false) p.set('ground', 'false');
  if (orbit === false) p.set('orbit', 'false');

  return url.toString();
}

/**
 * <Agent3D> embeds a three.ws walking 3D AI agent via a sandboxed iframe.
 *
 * The 3D runtime (Three.js / WebGL) lives inside three.ws; this component is a
 * thin, dependency-free wrapper around the embed player and its postMessage
 * protocol. Also exported as <WalkEmbed>.
 */
const Agent3D = forwardRef(function Agent3D(
  {
    agentId,
    avatarId,
    controls = 'joystick',
    background,
    environment,
    autoplay,
    ground,
    orbit,
    speed,
    width = '100%',
    height = '600px',
    baseUrl = DEFAULT_BASE_URL,
    onLoad,
    onError,
    className,
    style,
    title = 'three.ws 3D agent',
    ...rest
  },
  ref,
) {
  const iframeRef = useRef(null);

  const src = useMemo(
    () =>
      buildEmbedSrc({
        baseUrl,
        agentId,
        avatarId,
        controls,
        background,
        environment,
        autoplay,
        ground,
        orbit,
      }),
    [baseUrl, agentId, avatarId, controls, background, environment, autoplay, ground, orbit],
  );

  // The only origin we trust for inbound messages, derived from the embed URL.
  const targetOrigin = useMemo(() => new URL(src).origin, [src]);

  const post = useCallback(
    (msg) => {
      iframeRef.current?.contentWindow?.postMessage(msg, targetOrigin);
    },
    [targetOrigin],
  );

  // Imperative handle: drive the live embed from the host app.
  useImperativeHandle(
    ref,
    () => ({
      sendMessage: (msg) => post(msg),
      setAvatar: (id) => post({ type: 'walk:setAvatar', id }),
      setMotion: (motion) => post({ type: 'walk:setMotion', motion }),
      setEnvironment: (env) => post({ type: 'walk:setEnv', env }),
      setSpeed: (value) => post({ type: 'walk:config', speed: value }),
      narrate: (text) => post({ type: 'walk:narrate', text }),
      resetPose: () => post({ type: 'walk:resetPose' }),
      get iframe() {
        return iframeRef.current;
      },
    }),
    [post],
  );

  // Latest-callback refs so the message listener never goes stale and we don't
  // re-bind it on every render.
  const onLoadRef = useRef(onLoad);
  const onErrorRef = useRef(onError);
  onLoadRef.current = onLoad;
  onErrorRef.current = onError;

  useEffect(() => {
    function handleMessage(event) {
      // Strictly reject any origin that isn't the embed origin (XSS guard), and
      // ignore messages that didn't come from our own iframe.
      if (event.origin !== targetOrigin) return;
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;

      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'walk:ready') {
        if (typeof speed === 'number') post({ type: 'walk:config', speed });
        onLoadRef.current?.();
      } else if (data.type === 'walk:error') {
        onErrorRef.current?.(new Error(data.error || 'three.ws embed failed to load'));
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [targetOrigin, speed, post]);

  const wrapperStyle = {
    position: 'relative',
    width: toCssSize(width),
    height: toCssSize(height),
    ...style,
  };

  return (
    <div className={className} style={wrapperStyle} {...rest}>
      <iframe
        ref={iframeRef}
        src={src}
        title={title}
        allow="xr-spatial-tracking; microphone; camera; autoplay"
        loading="lazy"
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          border: 0,
        }}
      />
    </div>
  );
});

export { Agent3D };
