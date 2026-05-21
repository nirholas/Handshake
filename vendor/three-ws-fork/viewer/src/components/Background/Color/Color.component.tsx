import React, { FC } from 'react';

export type BackgroundColorProps = {
  /**
   * CSS-style string. Accepts Hexadeximal, RGB, X11 color name, HSL string
   * For example: '#000', 'red', 'rgb(255, 0, 0)'.
   * Doesn't support CSS gradients.
   */
  color: string;
};

export const BackgroundColor: FC<BackgroundColorProps> = ({ color }) => <color attach="background" args={[color]} />;
