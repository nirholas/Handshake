import type * as React from 'react';

export type Agent3DControls = 'joystick' | 'keyboard' | 'none';

export interface Agent3DProps {
  /** The three.ws agent ID. Used as the avatar to render unless `avatarId` is set. */
  agentId: string;
  /** Override the agent's default avatar with a specific avatar ID. */
  avatarId?: string;
  /** Movement controls. Defaults to `"joystick"`. */
  controls?: Agent3DControls;
  /** Background: `"transparent"` or a hex color like `"#1b1b1b"`. */
  background?: string;
  /** Environment preset (e.g. `"studio"`). */
  environment?: string;
  /** Autoplay an idle walk loop. */
  autoplay?: boolean;
  /** Show the shadow ground disc. Defaults to `true`. */
  ground?: boolean;
  /** Allow orbit drag on desktop. Defaults to `true`. */
  orbit?: boolean;
  /** Walk-speed multiplier (0.3-3). Applied live once the scene is ready. */
  speed?: number;
  /** Container width. Number is treated as px. Defaults to `"100%"`. */
  width?: string | number;
  /** Container height. Number is treated as px. Defaults to `"600px"`. */
  height?: string | number;
  /** Override the embed origin (advanced / self-host). Defaults to `https://three.ws`. */
  baseUrl?: string;
  /** Fires when the 3D scene is ready. */
  onLoad?: () => void;
  /** Fires on load failure. */
  onError?: (err: Error) => void;
  /** CSS class on the wrapper `<div>`. */
  className?: string;
  /** Inline styles on the wrapper `<div>`. */
  style?: React.CSSProperties;
  /** Accessible title for the underlying iframe. */
  title?: string;
}

/** Imperative handle exposed via `ref` for driving the live embed. */
export interface Agent3DHandle {
  /** Post an arbitrary message to the embed (advanced). */
  sendMessage: (msg: unknown) => void;
  /** Swap the rendered avatar live. */
  setAvatar: (id: string) => void;
  /** Set motion: `"idle" | "walk" | "run"`. */
  setMotion: (motion: 'idle' | 'walk' | 'run') => void;
  /** Switch the environment preset live. */
  setEnvironment: (env: string) => void;
  /** Set the walk-speed multiplier live (0.3-3). */
  setSpeed: (value: number) => void;
  /** Show a speech bubble above the avatar. */
  narrate: (text: string) => void;
  /** Recenter the avatar on the ground. */
  resetPose: () => void;
  /** The underlying iframe element, if mounted. */
  readonly iframe: HTMLIFrameElement | null;
}

export declare const Agent3D: React.ForwardRefExoticComponent<
  Agent3DProps & React.RefAttributes<Agent3DHandle>
>;

/** Alias for {@link Agent3D}, matches existing three.ws embed snippets. */
export declare const WalkEmbed: typeof Agent3D;
