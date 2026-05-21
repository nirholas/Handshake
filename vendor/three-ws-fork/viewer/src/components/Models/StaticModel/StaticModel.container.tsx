import React, { FC, Suspense, useState } from 'react';
import { StaticModel, StaticModelProps } from './StaticModel.component';

/**
 * Contains model to handle suspense fallback.
 */
export const StaticModelContainer: FC<StaticModelProps> = (props) => {
  /* eslint-disable-next-line react/jsx-no-useless-fragment */
  const [fallback, setFallback] = useState<JSX.Element>(<></>);

  return (
    <Suspense fallback={fallback}>
      <StaticModel setModelFallback={setFallback} {...props} />
    </Suspense>
  );
};
