import React, { FC, Suspense, useState } from 'react';

import { MultipleAnimationModel, MultipleAnimationModelProps } from './MultipleAnimationModel.component';

/**
 * Contains model to handle suspense fallback.
 */
export const MultipleAnimationModelContainer: FC<MultipleAnimationModelProps> = (props) => {
  /* eslint-disable-next-line react/jsx-no-useless-fragment */
  const [fallback, setFallback] = useState<JSX.Element>(<></>);

  return (
    <Suspense fallback={fallback}>
      <MultipleAnimationModel setModelFallback={setFallback} {...props} />
    </Suspense>
  );
};
