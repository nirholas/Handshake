import React, { FC, Suspense, useState } from 'react';
import { HalfBodyModel, HalfBodyModelProps } from './HalfBodyModel.component';

/**
 * Contains model to handle suspense fallback.
 */
export const HalfBodyModelContainer: FC<HalfBodyModelProps> = (props) => {
  /* eslint-disable-next-line react/jsx-no-useless-fragment */
  const [fallback, setFallback] = useState<JSX.Element>(<></>);

  return (
    <Suspense fallback={fallback}>
      <HalfBodyModel setModelFallback={setFallback} {...props} />
    </Suspense>
  );
};
