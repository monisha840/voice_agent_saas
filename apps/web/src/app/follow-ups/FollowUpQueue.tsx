"use client";

import { useState } from "react";
import { FollowUpList } from "@/components/FollowUpList";
import { EmptyState } from "@/components/StateViews";
import type { FollowUpQueueItem } from "@/lib/types";

/** The team's queue of things the agent noted during calls. A cleared item leaves the queue at once. */
export function FollowUpQueue({ initial, canClear }: { initial: FollowUpQueueItem[]; canClear: boolean }) {
  const [items, setItems] = useState(initial);
  if (items.length === 0) {
    return <EmptyState title="Nothing to follow up" description="When a caller asks for a person, a callback or a detail the agent could not give, it appears here." />;
  }
  return <FollowUpList items={items} canClear={canClear} onCleared={(id) => setItems((prev) => prev.filter((f) => f.id !== id))} />;
}
