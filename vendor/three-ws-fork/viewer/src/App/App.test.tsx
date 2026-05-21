import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App.component';

test('renders application without fault', () => {
  render(<App />);
  const el = screen.getByText(/localhost playground/i);
  expect(el).toBeInTheDocument();
});
