// Paseo provides React in its client bundle. The locked SDK publishes its declarations
// without @types/react. Describe the host signatures used by this plugin and its SDK UI.
declare module "react" {
  export type ReactElement = import("react/jsx-runtime").JSX.Element;
  export type ReactNode = ReactElement | string | number | boolean | null | undefined | readonly ReactNode[];
  export type ComponentType<Props = Record<never, never>> = (props: Props) => ReactNode;
  export type FunctionComponent<Props> = ComponentType<Props>;
  export type ForwardRefExoticComponent<Props> = ComponentType<Props>;
  export type Ref<T> = ((value: T | null) => void) | { current: T | null } | null;
  export type RefAttributes<T> = { ref?: Ref<T> };
  export function useRef<T>(initial: T): { current: T };
  export function useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void;
  export function useState<T>(initial: T): [T, (value: T) => void];
  export function useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, read: () => T): T;
}
declare module "react/jsx-runtime" {
  export namespace JSX {
    interface Element { readonly type: unknown; readonly props: unknown }
    type ElementType = (props: never) => import("react").ReactNode;
    interface IntrinsicAttributes { key?: string | number }
    interface ElementChildrenAttribute { children: unknown }
  }
}
declare module "react-native" {
  type NativeProps = { children?: import("react").ReactNode; style?: Record<string, string | number> };
  export const Text: import("react").ComponentType<NativeProps>;
  export const View: import("react").ComponentType<NativeProps & {
    accessibilityRole?: "progressbar";
    accessibilityLabel?: string;
    "aria-valuemin"?: number;
    "aria-valuemax"?: number;
    "aria-valuenow"?: number;
    "aria-valuetext"?: string;
  }>;
}
