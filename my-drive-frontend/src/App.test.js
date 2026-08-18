import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders my_drive login heading", () => {
  render(<App />);
  expect(screen.getByText(/my_drive/i)).toBeInTheDocument();
});
