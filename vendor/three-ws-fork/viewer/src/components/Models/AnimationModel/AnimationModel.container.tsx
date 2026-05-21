import React, { FC, Suspense, useState } from 'react';
import { AnimationModel, AnimationModelProps } from './AnimationModel.component';

/**
 * Contains model to handle suspense fallback.
 */
export const AnimationModelContainer: FC<AnimationModelProps> = (props) => {
  /* eslint-disable-next-line react/jsx-no-useless-fragment */
  const [fallback, setFallback] = useState<JSX.Element>(<></>);

  return (
    <Suspense fallback={fallback}>
      <AnimationModel setModelFallback={setFallback} {...props} />
    </Suspense>
  );
};
