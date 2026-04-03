import { styleText } from "node:util";
import { cursorHide } from "@inquirer/ansi";
import {
	createPrompt,
	isDownKey,
	isEnterKey,
	isNumberKey,
	isSpaceKey,
	isUpKey,
	type KeypressEvent,
	makeTheme,
	Separator,
	useEffect,
	useKeypress,
	useMemo,
	usePagination,
	usePrefix,
	useRef,
	useState,
} from "@inquirer/core";
import figures from "@inquirer/figures";

interface Choice<Value> {
	value: Value;
	name?: string;
	short?: string;
	disabled?: boolean | string;
	checked?: boolean;
}

interface NormalizedChoice<Value> {
	value: Value;
	name: string;
	short: string;
	disabled: boolean | string;
	checked: boolean;
}

interface LiveCheckboxConfig<Value> {
	message: string;
	choices: ReadonlyArray<Choice<Value> | Separator>;
	pageSize?: number;
	loop?: boolean;
	/**
	 * Called once when the prompt renders. Fetch fresh data in the background
	 * and call `onUpdate(value, newName)` for each choice whose label should change.
	 * Check `signal.aborted` between batches to stop early on prompt exit.
	 */
	fetchLabels?: (
		onUpdate: (value: Value, newName: string) => void,
		signal: AbortSignal,
	) => Promise<void>;
}

const theme = {
	icon: {
		checked: styleText("green", figures.circleFilled),
		unchecked: figures.circle,
		cursor: figures.pointer,
	},
	style: {
		disabled: (text: string) => styleText("dim", text),
		renderSelectedChoices: <T>(selected: ReadonlyArray<NormalizedChoice<T>>) =>
			selected.map((c) => c.short).join(", "),
		keysHelpTip: (keys: [string, string][]) =>
			keys
				.map(
					([key, action]) =>
						`${styleText("bold", key)} ${styleText("dim", action)}`,
				)
				.join(styleText("dim", " · ")),
	},
};

function isSelectable<V>(
	item: NormalizedChoice<V> | Separator,
): item is NormalizedChoice<V> {
	return !Separator.isSeparator(item) && !item.disabled;
}

function isNavigable<V>(item: NormalizedChoice<V> | Separator): boolean {
	return !Separator.isSeparator(item);
}

function normalizeChoices<V>(
	choices: ReadonlyArray<Choice<V> | Separator>,
): (NormalizedChoice<V> | Separator)[] {
	return choices.map((choice) => {
		if (Separator.isSeparator(choice)) return choice;
		const name = choice.name ?? String(choice.value);
		return {
			value: choice.value,
			name,
			short: choice.short ?? name,
			disabled: choice.disabled ?? false,
			checked: choice.checked ?? false,
		};
	});
}

export default createPrompt(
	(config: LiveCheckboxConfig<number>, done: (value: number[]) => void) => {
		const { pageSize = 15, loop = true } = config;
		const resolved = makeTheme(theme);

		const [status, setStatus] = useState<"idle" | "done">("idle");
		const prefix = usePrefix({ status, theme: resolved });
		const [items, setItems] = useState(() => normalizeChoices(config.choices));
		const [active, setActive] = useState(() => {
			const idx = items.findIndex(
				(i) => !Separator.isSeparator(i) && !i.disabled,
			);
			return idx >= 0 ? idx : 0;
		});

		// Live-update tracking: store name overrides in a ref (mutable, no re-render),
		// bump a counter state to trigger re-renders when updates arrive.
		const updatesRef = useRef(new Map<number, string>());
		const [refreshed, setRefreshed] = useState(0);
		const fetchableCount = useRef(items.filter((i) => isSelectable(i)).length);
		const startedRef = useRef(false);
		const abortRef = useRef<AbortController | undefined>(undefined);

		useEffect(() => {
			if (startedRef.current || !config.fetchLabels) return;
			startedRef.current = true;
			const controller = new AbortController();
			abortRef.current = controller;

			config
				.fetchLabels((value: number, newName: string) => {
					updatesRef.current.set(value, newName);
					setRefreshed(updatesRef.current.size);
				}, controller.signal)
				.catch(() => {
					/* ignore — prompt may have been aborted */
				});

			return () => {
				controller.abort();
			};
		}, []);

		const bounds = useMemo(() => {
			const first = items.findIndex(
				(i: NormalizedChoice<number> | Separator) => !Separator.isSeparator(i),
			);
			let last = -1;
			for (let j = items.length - 1; j >= 0; j--) {
				const item = items[j];
				if (item && !Separator.isSeparator(item)) {
					last = j;
					break;
				}
			}
			return { first: first >= 0 ? first : 0, last: last >= 0 ? last : 0 };
		}, [items]);

		useKeypress((_key: KeypressEvent) => {
			if (isEnterKey(_key)) {
				const selection = items.filter(
					(i) => !Separator.isSeparator(i) && i.checked,
				);
				setStatus("done");
				abortRef.current?.abort();
				done(selection.map((i) => (i as NormalizedChoice<number>).value));
			} else if (isUpKey(_key) || isDownKey(_key)) {
				if (
					loop ||
					(isUpKey(_key) && active !== bounds.first) ||
					(isDownKey(_key) && active !== bounds.last)
				) {
					const offset = isUpKey(_key) ? -1 : 1;
					let next = active;
					do {
						next = (next + offset + items.length) % items.length;
						// biome-ignore lint/style/noNonNullAssertion: index always in bounds within modular arithmetic loop
					} while (!isNavigable(items[next]!));
					setActive(next);
				}
			} else if (isSpaceKey(_key)) {
				const item = items[active];
				if (item && isSelectable(item)) {
					setItems(
						items.map((choice, i) => {
							if (i !== active || Separator.isSeparator(choice)) return choice;
							return { ...choice, checked: !choice.checked };
						}),
					);
				}
			} else if (_key.name === "a") {
				const selectAll = items.some((c) => isSelectable(c) && !c.checked);
				setItems(
					items.map((c) =>
						isSelectable(c) ? { ...c, checked: selectAll } : c,
					),
				);
			} else if (_key.name === "i") {
				setItems(
					items.map((c) =>
						isSelectable(c) ? { ...c, checked: !c.checked } : c,
					),
				);
			} else if (isNumberKey(_key)) {
				const target = Number(_key.name) - 1;
				let selectableIdx = -1;
				const pos = items.findIndex((item) => {
					if (Separator.isSeparator(item)) return false;
					selectableIdx++;
					return selectableIdx === target;
				});
				const it = items[pos];
				if (it && isSelectable(it)) {
					setActive(pos);
					setItems(
						items.map((c, i) =>
							i === pos && isSelectable(c) ? { ...c, checked: !c.checked } : c,
						),
					);
				}
			}
		});

		const hasFetcher = !!config.fetchLabels;
		const total = fetchableCount.current;
		const allDone = refreshed >= total;

		const message = resolved.style.message(config.message, status);

		if (status === "done") {
			const selection = items.filter(
				(i) => !Separator.isSeparator(i) && i.checked,
			) as NormalizedChoice<number>[];
			// Apply any name updates for the final summary
			const displaySelection = selection.map((s) => {
				const updated = updatesRef.current.get(s.value);
				return updated ? { ...s, short: updated } : s;
			});
			const answer = resolved.style.answer(
				theme.style.renderSelectedChoices(displaySelection),
			);
			return [prefix, message, answer].filter(Boolean).join(" ");
		}

		// Force a dependency on `refreshed` so usePagination re-renders
		void refreshed;

		const page = usePagination({
			items,
			active,
			renderItem({
				item,
				isActive,
			}: {
				item: NormalizedChoice<number> | Separator;
				index: number;
				isActive: boolean;
			}) {
				if (Separator.isSeparator(item)) {
					return ` ${item.separator}`;
				}

				const cursor = isActive ? theme.icon.cursor : " ";
				if (item.disabled) {
					return theme.style.disabled(
						`${cursor}${theme.icon.unchecked} ${item.name}`,
					);
				}

				const checkbox = item.checked
					? theme.icon.checked
					: theme.icon.unchecked;

				// Apply live name update if available
				const updatedName = updatesRef.current.get(item.value);
				let displayName: string;
				if (updatedName) {
					displayName = updatedName;
				} else if (hasFetcher) {
					displayName = `${item.name} ${styleText("dim", "…")}`;
				} else {
					displayName = item.name;
				}

				const color = isActive ? resolved.style.highlight : (x: string) => x;
				return color(`${cursor}${checkbox} ${displayName}`);
			},
			pageSize,
			loop,
		});

		const keys: [string, string][] = [
			["↑↓", "navigate"],
			["space", "select"],
			["a", "all"],
			["i", "invert"],
			["⏎", "submit"],
		];
		const helpLine = theme.style.keysHelpTip(keys);

		let refreshLine = "";
		if (hasFetcher && !allDone) {
			refreshLine = styleText(
				"dim",
				`  Refreshing tag counts… (${refreshed}/${total})`,
			);
		} else if (hasFetcher && allDone) {
			refreshLine = styleText("dim", "  Tag counts refreshed ✓");
		}

		const lines = [
			[prefix, message].filter(Boolean).join(" "),
			page,
			refreshLine,
			helpLine,
		]
			.filter(Boolean)
			.join("\n")
			.trimEnd();

		return `${lines}${cursorHide}`;
	},
);

export { Separator } from "@inquirer/core";
