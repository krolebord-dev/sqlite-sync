# Watchlist App - Feature Suggestions

Feature ideas organized by category, building on the existing offline-first CRDT architecture, TMDB integration, and AI capabilities.

---

## 1. Social & Collaboration

### 1.1 Activity Feed

Show a timeline of recent actions across shared lists: who added an item, who marked something as watched, rating changes, etc. The CRDT event log already captures all mutations with timestamps and could be surfaced directly as an activity stream.

- Per-list activity tab showing recent changes
- Attribution via user metadata on CRDT events
- Filterable by action type (added, watched, rated, removed)

### 1.2 Per-Item Comments & Notes

Let list members leave short notes or mini-reviews on individual items. Useful for shared lists where someone wants to say "trust me, watch this one" or leave context about why they added something.

- New CRDT table (`_comment`) linked to item ID
- Displayed in the item detail/expand view
- Syncs offline like everything else

### 1.3 Group Watch Voting

For shared lists, let members vote on what to watch next. Propose a "movie night" session where each member ranks their top picks from the unwatched items, and the app tallies a winner.

- New CRDT table for votes scoped to a voting session
- Simple ranked-choice or thumbs-up/down mechanism
- Result displayed as a ranked shortlist

---

## 2. Discovery & Recommendations

### 2.1 "What Should I Watch?" Randomizer

A quick-pick button that randomly selects an unwatched item, optionally filtered by constraints: maximum duration, minimum rating, specific tags, or priority level. Simple but solves the "scrolling paralysis" problem.

### 2.2 Mood / Vibe Tags

Extend the existing tag system with a curated set of mood-based tags (e.g., "feel-good", "intense", "date-night", "background-watch", "mind-bending"). Could be AI-suggested alongside the current auto-tags, or manually applied. Enables mood-based filtering when deciding what to watch.

### 2.3 "More Like This" from Any Item

The AI recommendation system already supports custom prompts. Surface a one-click "More Like This" action on each item card that pre-fills the recommendation prompt with that specific title, returning similar items and optionally auto-adding them to the list.

### 2.4 Trending / Popular Feed

Show what's currently popular or trending on TMDB as a discovery surface. Users can quickly add trending items to any of their lists. Low implementation cost since TMDB already has trending endpoints.

---

## 3. Tracking & Organization

### 3.1 Franchise & Series Grouping

Group related movies into franchises (MCU, Lord of the Rings, Star Wars, etc.) using TMDB's collection metadata. Show franchise progress (e.g., "3/8 watched") and suggest the next entry in release or chronological order.

### 3.2 TV Show Season Progress

For TV series, track progress at the season/episode level instead of treating the entire show as a single watched/unwatched toggle. Show which seasons have been completed and how many episodes remain.

- Extend the item schema with season/episode tracking fields
- Fetch season data from TMDB's TV season endpoints
- Progress bar on TV item cards

### 3.3 Custom Sort Orders (Manual Drag & Drop)

Allow users to manually reorder items via drag-and-drop in addition to the existing sort options. Stored as a `sortOrder` field on items, synced via CRDT.

### 3.4 Multiple Views (Grid / List / Compact)

The app currently uses a poster-card grid. Add alternative view modes: a dense list view (title + year + rating in rows) for scanning large lists quickly, and a compact grid with smaller cards for seeing more at once.

---

## 4. Streaming & Availability

### 4.1 Availability Alerts

Notify users when an unwatched item becomes available on one of their preferred streaming services. Periodically re-check watch provider data from TMDB/JustWatch and surface new availability.

- Background polling of watch provider data for unwatched items
- In-app notification badge or dedicated "newly available" filter
- Optional push notifications (requires service worker, which is already planned)

### 4.2 "Where to Watch" Deep Links

For items with known watch provider data, provide direct deep links to open the item in the streaming app (Netflix, Disney+, etc.). Reduces friction from "I want to watch this" to actually watching it.

### 4.3 Price Comparison for Rentals/Purchases

When an item is only available to rent or buy, show a price comparison across providers so users can find the cheapest option. Data partially available through TMDB's watch provider API.

---

## 5. Data & Insights

### 5.1 Enhanced Statistics Dashboard

Expand the existing list statistics into a dedicated analytics view:

- Watch pace over time (items watched per week/month chart)
- Genre distribution breakdown (pie/bar chart)
- Average user rating vs. TMDB rating scatter plot
- Total watch time accumulation
- Longest unwatched items (items sitting on the list the longest)

### 5.2 Year in Review / Wrapped

An annual summary of watching habits: total items watched, total hours, favorite genres, highest/lowest rated, most productive month, etc. Shareable as an image or link.

### 5.3 Taste Profile Page

Surface the taste profile that already gets built for AI recommendations as a user-facing page. Show top genres, preferred decades, rating tendencies, and how tastes compare across shared list members.

---

## 6. Import & Export

### 6.1 External Service Import

Import watchlists from popular platforms:

- **Letterboxd**: CSV export (well-documented format)
- **IMDb**: Watchlist/ratings CSV export
- **Trakt.tv**: API or CSV import
- Match imported titles to TMDB IDs for full metadata

### 6.2 Calendar Export (iCal)

Export upcoming release dates for unwatched items (especially TV shows with upcoming seasons) as an iCal feed that users can subscribe to in their calendar app.

### 6.3 Share List as Public Read-Only Page

Generate a public URL for a list that non-authenticated users can view (but not edit). Useful for sharing recommendations with friends who don't have an account.

---

## 7. Offline & Performance

### 7.1 Offline Recommendation Cache

Pre-fetch and cache AI recommendations so they're available when offline. When the user goes online, refresh the cache in the background. Complements the planned service worker offline support.

### 7.2 Poster Image Caching

Cache poster images in the service worker so list browsing works fully offline. Currently, going offline would show the list data but broken poster images.

### 7.3 Background Sync Queue

When mutations happen offline (adding items, marking as watched), queue them visually so users can see pending changes that haven't synced yet. The CRDT layer handles sync correctness, but a visible queue improves user confidence.

---

## Implementation Priority Suggestion

| Priority | Feature | Rationale |
|----------|---------|-----------|
| High | Randomizer (2.1) | Minimal effort, high daily-use value |
| High | Activity Feed (1.1) | Data already exists in CRDT events |
| High | External Import (6.1) | Removes onboarding friction |
| Medium | Franchise Grouping (3.1) | TMDB collection data is readily available |
| Medium | Enhanced Stats (5.1) | Data already exists locally |
| Medium | Per-Item Comments (1.2) | Natural extension of CRDT model |
| Medium | Availability Alerts (4.1) | Depends on service worker (planned) |
| Lower | TV Season Progress (3.2) | Schema changes + significant UI work |
| Lower | Group Watch Voting (1.3) | Niche use case, new CRDT table |
| Lower | Year in Review (5.2) | Seasonal feature, lower urgency |
