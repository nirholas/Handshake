import React, { FC, Suspense, useState } from 'react';
import { PoseModel, PoseModelProps } from './PoseModel.component';

/**
 * Contains model to handle suspense fallback.
 */
export const PoseModelContainer: FC<PoseModelProps> = (props) => {
  /* eslint-disable-next-line react/jsx-no-useless-fragment */
  const [fallback, setFallback] = useState<JSX.Element>(<></>);

  return (
    <Suspense fallback={fallback}>
      <PoseModel setModelFallback={setFallback} {...props} />
    </Suspense>
  );
};
