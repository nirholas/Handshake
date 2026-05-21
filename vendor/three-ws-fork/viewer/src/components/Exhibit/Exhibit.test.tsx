import React from 'react';
import { render, RenderResult } from '@testing-library/react';
import { Exhibit } from 'src/components/Exhibit';
import { act } from '@react-three/fiber';

describe('Exhibit component', () => {
  it('should mount without errors', async () => {
    let renderer: RenderResult = null!;
    act(() => {
      renderer = render(<Exhibit modelSrc="https://www.__test__.it/works.glb" />);
    });

    expect(renderer.container).toMatchSnapshot();
  });

  it('should change background color', async () => {
    const teal = {
      hex: '#008080'
    };

    let renderer: RenderResult = null!;
    act(() => {
      renderer = render(<Exhibit modelSrc="" style={{ background: teal.hex }} />);
    });

    expect(renderer.container).toMatchSnapshot();
  });
});
