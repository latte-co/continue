import { createContext, useContext } from "react";

export type DefaultControlSize = "lg" | "md" | "sm";

export const ControlSizeContext = createContext<DefaultControlSize | undefined>(
  undefined,
);

export function useDefaultControlSize(): DefaultControlSize | undefined {
  return useContext(ControlSizeContext);
}
