import React, { FC, useEffect } from 'react';
import { useThree } from '@react-three/fiber';

type CaptureSettingsType = {
  quality?: number;
  type?: string;
};

export type CaptureType = {
  trigger: boolean;
  callBack: (capture?: string) => void;
  settings?: CaptureSettingsType;
};

type CaptureProps = CaptureType;

const Capture: FC<CaptureProps> = ({ trigger, settings, callBack }) => {
  const gl = useThree((state) => state.gl);

  const type = settings?.type || 'image/png';
  const quality = settings?.quality || 0.1;

  useEffect(() => {
    if (trigger) {
      const capture = gl.domElement.toDataURL(type, quality);

      callBack(capture);
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [trigger]);

  // eslint-disable-next-line react/jsx-no-useless-fragment
  return <></>;
};

export default Capture;
