import React, { FC, Suspense, useState } from 'react';
import { RotatingModel, RotatingModelProps } from './RotatingModel.component';

/**
 * Contains model to handle suspense fallback.
 */
export const RotatingModelContainer: FC<RotatingModelProps> = (props) => {
  /* eslint-disable-next-line react/jsx-no-useless-fragment */
  const [fallback, setFallback] = useState<JSX.Element>(<></>);

  return (
    <Suspense fallback={fallback}>
      <RotatingModel {...props} setModelFallback={setFallback} />
    </Suspense>
  );
};
