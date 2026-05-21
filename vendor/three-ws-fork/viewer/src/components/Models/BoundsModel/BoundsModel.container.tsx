import React, { FC, ReactNode, useEffect, useState, cloneElement, useMemo, ReactElement, useCallback } from 'react';
import { useBounds } from '@react-three/drei';
import { BaseModelProps } from 'src/types';
import { triggerCallback } from 'src/services';

export interface BoundsModelContainerProps extends BaseModelProps {
  modelSrc: string | Blob;
  children?: ReactNode | ReactNode[];
  fit?: boolean;
}

export const BoundsModelContainer: FC<BoundsModelContainerProps> = ({ modelSrc, children, fit, onLoaded }) => {
  const bounds = useBounds();
  const [fallback, setFallback] = useState<JSX.Element>(<></>);

  const onChildLoaded = useCallback(() => {
    if (fit) {
      bounds.refresh().clip().fit();
    }

    triggerCallback(onLoaded);
  }, [bounds, fit]);

  const childModel = useMemo(
    () =>
      React.Children.map(children, (child) =>
        cloneElement(child as ReactElement, { setModelFallback: setFallback, onLoaded: onChildLoaded })
      ),
    [modelSrc, children, onChildLoaded]
  );

  useEffect(() => {
    if (fit) {
      bounds.refresh().clip().fit();
    }
  }, [modelSrc, fit, fallback]);

  return <>{childModel}</>;
};
