import React, { FC, Suspense, useState } from 'react';
import { FloatingModel, FloatingModelProps } from './FloatingModel.component';

/**
 * Contains model to handle suspense fallback.
 */
export const FloatingModelContainer: FC<FloatingModelProps> = (props) => {
  /* eslint-disable-next-line react/jsx-no-useless-fragment */
  const [fallback, setFallback] = useState<JSX.Element>(<></>);

  return (
    <Suspense fallback={fallback}>
      <FloatingModel {...props} setModelFallback={setFallback} />
    </Suspense>
  );
};
