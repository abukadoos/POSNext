import { ref, watch, nextTick, onUnmounted } from "vue"
import { QueuedMutex } from "@/utils/mutex"

/**
 * Composable for search input, barcode scanning, and auto-add logic.
 *
 * Owns all search-input state, timers, and event handlers with proper
 * concurrency control.  Extracted from ItemsSelector.vue.
 *
 * Concurrency model:
 *   - On Enter (or auto-add timeout), the barcode is **snapshotted** from the
 *     DOM input immediately, then the input is cleared so the next scan starts
 *     into a clean field.
 *   - The snapshot is pushed into a {@link QueuedMutex}-backed queue
 *     (`processBarcodeScan`), which processes barcode lookups sequentially.
 *   - This guarantees no barcode is ever lost, even when scanning different
 *     items faster than the API can respond (~50 ms between scans).
 *
 * @param {Object} options
 * @param {Object} options.itemStore          - Pinia item-search store
 * @param {(item: Object, autoAdd: boolean) => boolean} options.onItemFound
 *        Component's selectItem(). Returns true if item was accepted.
 * @param {Object} options.showWarning        - useToast().showWarning
 * @param {import('vue').Ref<boolean>} options.isAnyDialogOpen
 * @param {(barcode: string) => Promise<boolean>} [options.tryCustomerBarcode]
 *        Optional. If barcode starts with "101", called with full barcode; return true if handled (e.g. customer set).
 * @param {(barcode: string) => void} [options.onBarcodeNotFound]
 *        Optional. When barcode lookup finds no item, called with the barcode (e.g. to show a modal). If not provided, uses showWarning.
 */
export function useSearchInput({ itemStore, onItemFound, showWarning, isAnyDialogOpen, tryCustomerBarcode, onBarcodeNotFound }) {
	// --- Reactive state (exposed) ---
	const searchInputRef = ref(null)
	const scannerEnabled = ref(false)
	const autoAddEnabled = ref(false)

	// --- Internal (non-reactive) ---
	let autoSearchTimer = null
	let refocusTimer = null
	const REFOCUS_DELAY_MS = 2500
	const barcodeQueue = new QueuedMutex({ timeout: 10000, name: "BarcodeSearch" })

	/** Heuristic: value looks like a barcode (so we do barcode API), not a name search. */
	function looksLikeBarcode(value) {
		const s = (value || "").trim()
		if (!s) return false
		// Customer POS id pattern
		if (s.startsWith("101") && s.length >= 6) return true
		// Typical scanned: EAN-13, UPC, or embedded 20xxxxx (length 8+)
		if (s.length >= 8) return true
		// Short numeric (e.g. scale 00010)
		if (s.length >= 5 && /^\d+$/.test(s)) return true
		return false
	}

	// ---- Timer helpers ----

	function clearAutoSearchTimer() {
		if (autoSearchTimer) {
			clearTimeout(autoSearchTimer)
			autoSearchTimer = null
		}
	}

	function clearRefocusTimer() {
		if (refocusTimer) {
			clearTimeout(refocusTimer)
			refocusTimer = null
		}
	}

	// ---- Focus ----

	function focusSearchInput() {
		nextTick(() => {
			if (searchInputRef.value) {
				searchInputRef.value.focus()
			}
		})
	}

	// ---- Clear ----

	/** Atomic clear: timer -> store -> DOM input.value -> refocus */
	function clearSearchAndResetInput() {
		clearAutoSearchTimer()
		itemStore.clearSearch()
		if (searchInputRef.value) {
			searchInputRef.value.value = ""
		}
		if (scannerEnabled.value || autoAddEnabled.value) {
			focusSearchInput()
		}
	}

	// ---- Event handlers ----

	function handleKeyDown(event) {
		if (event.key === "Enter") {
			event.preventDefault()
			clearAutoSearchTimer()

			const value = searchInputRef.value?.value?.trim() || itemStore.searchTerm?.trim()
			if (!value) return

			// Only run barcode lookup when scanner/auto-add is on AND value looks like a barcode.
			// Otherwise leave search as-is so name search results stay visible (user can click an item).
			if ((scannerEnabled.value || autoAddEnabled.value) && looksLikeBarcode(value)) {
				itemStore.clearSearch()
				if (searchInputRef.value) searchInputRef.value.value = ""
				processBarcodeScan(value, autoAddEnabled.value)
			}
			return
		}
	}

	/**
	 * Handles the `input` event on the search <input>.
	 *
	 * Two independent timers exist by design:
	 *   1. itemStore.setSearchTerm() triggers the store's own debounce for
	 *      updating the displayed item grid.
	 *   2. autoSearchTimer (500 ms) triggers auto-add behaviour — completely
	 *      separate from display.
	 */
	function handleSearchInput(event) {
		const value = event.target.value

		// Guard: ignore stale empty events after search was already cleared
		if (!value && !itemStore.searchTerm) {
			return
		}

		itemStore.setSearchTerm(value)

		clearAutoSearchTimer()

		// Auto-add barcode scan only when value looks like a barcode (not a name).
		// Otherwise keep the search term so name search results show and user can click an item.
		if (autoAddEnabled.value && value.trim().length > 0 && looksLikeBarcode(value)) {
			autoSearchTimer = setTimeout(() => {
				const barcode = searchInputRef.value?.value?.trim() || itemStore.searchTerm?.trim()
				if (barcode && looksLikeBarcode(barcode)) {
					itemStore.clearSearch()
					if (searchInputRef.value) searchInputRef.value.value = ""
					processBarcodeScan(barcode, true)
				}
			}, 500)
		}
	}

	/** Clicking the search input clears search + timer atomically. */
	function handleSearchClick() {
		clearSearchAndResetInput()
	}

	/** When search input gains focus, cancel any pending refocus so we don’t steal focus. */
	function onSearchFocus() {
		clearRefocusTimer()
	}

	/**
	 * When search input loses focus and scanner/auto-add is on, refocus after a short delay
	 * so the cashier can keep scanning without re-tapping the field.
	 */
	function onSearchBlur() {
		clearRefocusTimer()
		if (!scannerEnabled.value && !autoAddEnabled.value) return
		if (isAnyDialogOpen?.value) return
		refocusTimer = setTimeout(() => {
			refocusTimer = null
			focusSearchInput()
		}, REFOCUS_DELAY_MS)
	}

	/**
	 * Queue a barcode scan for sequential processing.
	 *
	 * The barcode string is already captured (snapshotted) by the caller —
	 * it is never read from shared state here. The {@link QueuedMutex}
	 * ensures scans execute one at a time so every scan is resolved before
	 * the next begins, preventing double-adds and lost barcodes.
	 *
	 * Lookup: exact barcode match via `itemStore.searchByBarcode()`.
	 * If the barcode is not found, shows a "not found" warning.
	 *
	 * @param {string}  barcode      - Pre-captured barcode value
	 * @param {boolean} forceAutoAdd - When true, item is added without user click
	 */
	function processBarcodeScan(barcode, forceAutoAdd) {
		const shouldAutoAdd = forceAutoAdd || (scannerEnabled.value && autoAddEnabled.value)

		barcodeQueue.withLock(async () => {
			// If barcode starts with 101, treat as customer POS id (e.g. 101002977)
			const barcodeStr = String(barcode || '').trim()
			if (barcodeStr.startsWith('101') && tryCustomerBarcode && typeof tryCustomerBarcode === 'function') {
				try {
					const handled = await tryCustomerBarcode(barcodeStr)
					if (handled) {
						focusSearchInput()
						return
					}
				} catch (err) {
					console.error('Customer barcode (101) lookup failed:', err)
				}
			}

			try {
				const item = await itemStore.searchByBarcode(barcode)
				if (item) {
					onItemFound(item, shouldAutoAdd)
					focusSearchInput()
					return
				}
			} catch (error) {
				console.error("Barcode API error:", error)
			}

			// Barcode not found — show modal or toast so cashier can see and acknowledge.
			if (typeof onBarcodeNotFound === 'function') {
				onBarcodeNotFound(barcode)
			} else {
				showWarning(__('Item Not Found: No item found with barcode: {0}', [barcode]))
			}
			focusSearchInput()
		})
	}

	// ---- Toggles ----

	function toggleBarcodeScanner() {
		scannerEnabled.value = !scannerEnabled.value

		if (scannerEnabled.value) {
			autoAddEnabled.value = true
			focusSearchInput()
		} else {
			autoAddEnabled.value = false
		}
	}

	function toggleAutoAdd() {
		autoAddEnabled.value = !autoAddEnabled.value

		if (autoAddEnabled.value && !scannerEnabled.value) {
			scannerEnabled.value = true
		}

		if (!autoAddEnabled.value) {
			clearAutoSearchTimer()
		}

		if (autoAddEnabled.value) {
			focusSearchInput()
		}
	}

	// ---- Dialog-close watcher ----
	// Refocuses the search bar when all dialogs close (scanner/auto-add modes)
	const stopDialogWatcher = watch(isAnyDialogOpen, (isOpen, wasOpen) => {
		if (wasOpen && !isOpen && (scannerEnabled.value || autoAddEnabled.value)) {
			focusSearchInput()
		}
	})

	// ---- Cleanup ----
	function cleanup() {
		clearAutoSearchTimer()
		clearRefocusTimer()
		stopDialogWatcher()
	}

	onUnmounted(cleanup)

	return {
		// State
		searchInputRef,
		scannerEnabled,
		autoAddEnabled,

		// Event handlers
		handleSearchInput,
		handleKeyDown,
		handleSearchClick,
		onSearchFocus,
		onSearchBlur,

		// Toggles
		toggleBarcodeScanner,
		toggleAutoAdd,

		// Utilities
		focusSearchInput,
		clearSearchAndResetInput,
		cleanup,
	}
}
