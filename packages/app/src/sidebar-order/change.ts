export type LocalOrderChange = { serverIds: readonly string[] } & (
  | { kind: "renameGroup"; fromKey: string; toKey: string }
  | { kind: "projects" | "groups" | "pins"; keys: string[] }
  | { kind: "workspaces"; projectViewKey: string; keys: string[] }
);

export function renameOrderKey(order: string[], fromKey: string, toKey: string): string[] {
  if (fromKey === toKey || !order.includes(fromKey)) return order;
  const withoutTarget = order.filter((key) => key !== toKey);
  return withoutTarget.map((key) => (key === fromKey ? toKey : key));
}
