import React, { ReactNode, FC, CSSProperties } from 'react';
import { Canvas, Dpr } from '@react-three/fiber';
import { ACESFilmicToneMapping, Vector3 } from 'three';
import { CameraProps, CanvasConfiguration } from 'src/types';
import { hasWindow } from 'src/services/Client.service';
import styles from './BaseCanvas.module.scss';

interface BaseCanvasProps extends CameraProps {
  children?: ReactNode;
  fov?: number;
  style?: CSSProperties;
  dpr?: Dpr;
  className?: string;
  enablePostProcessing?: boolean;
  canvasConfig?: CanvasConfiguration;
}

const BASE_DPR = hasWindow ? window.devicePixelRatio : 1;

export const BaseCanvas: FC<BaseCanvasProps> = ({
  enablePostProcessing,
  children = undefined,
  fov = 50,
  position = new Vector3(0, 0, 5),
  style,
  dpr = [BASE_DPR * 0.5, 1],
  className,
  canvasConfig = { alpha: true }
}) => (
  <Canvas
    key={fov}
    className={`${styles['base-canvas']} ${className ?? ''}`}
    shadows="soft"
    gl={{
      preserveDrawingBuffer: true,
      alpha: canvasConfig.alpha,
      toneMapping: ACESFilmicToneMapping,
      toneMappingExposure: 1.8
    }}
    flat={enablePostProcessing}
    dpr={dpr}
    camera={{ fov, position }}
    resize={{ scroll: true, debounce: { scroll: 50, resize: 0 } }}
    style={{ ...style, background: canvasConfig.alpha ? 'transparent' : style?.background }}
  >
    {children}
  </Canvas>
);
