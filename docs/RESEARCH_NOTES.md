# Research notes — providers and constraints

## Amadeus Self-Service

### Confirmed
- Flight Offers Search is the first step of the flight booking flow.
- Flight Offers Price confirms availability and final price including taxes and fees.
- Flight Create Orders is the booking step, but production booking requires ticketing capability / consolidator workflow.
- Flight Cheapest Date Search uses dynamic cache data and should be followed by Flight Offers Search for real-time pricing and availability.
- Flight Offers Search supports carrier filters, cabin, `nonStop`, `maxPrice`, `currencyCode`, passenger mix and multi-city via `POST`.
- Airport & City Search supports autocomplete and sorting by traveler score / passenger volume.
- Dataset limitations exist in Self-Service:
  - no American Airlines,
  - no Delta,
  - no British Airways,
  - no low-cost carriers,
  - only published fares,
  - no negotiated/special rates.

### Implication
Amadeus is ideal as search/reprice core, but not enough for:
- full market coverage,
- deeplinks,
- “real purchase link” flows.

## Skyscanner

### Confirmed
- Flights Live Prices returns bookable itineraries and each itinerary includes a `deepLink`.
- `/create` returns an initial subset fast; `/poll` completes the result set.
- Refresh Prices can retrieve more up-to-date pricing, and cached results have a documented TTL of 10 minutes.
- Skyscanner requires sufficient itinerary detail before deeplinking and restricts where deeplink clicks can happen.
- Skyscanner FAQ states their Flights API is intended for flows that generate end-user bookings, not for price-only extraction.
- Flights Indicative Prices supports date aggregations and month/day-level exploration.
- Affiliates Link API supports redirects to Skyscanner pages such as day view, calendar month view, browse view and multicity.

### Implication
Skyscanner is valuable for:
- deeplinks,
- day/calendar redirects,
- exploratory pricing,
- secondary comparison.

But it should be treated as:
- optional,
- commercially reviewed,
- click-quality compliant.

## Travelpayouts / affiliate link generation

### Confirmed
- Travelpayouts can generate affiliate links to specific brand pages, including search result pages.
- Kiwi.com deep links can be built from exact search parameters.
- Aviasales links can point to search pages or specific flight tickets after proper affiliate flow.

### Implication
Useful as optional purchase-path layer or redirect helper, not as the main truth of pricing.

## Reference URLs

### Amadeus
- https://developers.amadeus.com/self-service/apis-docs/guides/developer-guides/resources/flights/
- https://developers.amadeus.com/self-service/category/flights/api-doc/flight-offers-search
- https://developers.amadeus.com/self-service/category/flights/api-doc/flight-offers-price
- https://developers.amadeus.com/self-service/category/flights/api-doc/flight-create-orders
- https://developers.amadeus.com/self-service/category/flights/api-doc/airport-and-city-search
- https://developers.amadeus.com/self-service/apis-docs/guides/developer-guides/faq/

### Skyscanner
- https://developers.skyscanner.net/docs/flights-live-prices/overview
- https://developers.skyscanner.net/docs/flights-live-prices/refresh-prices
- https://developers.skyscanner.net/docs/getting-started/usage-guidelines
- https://developers.skyscanner.net/docs/flights-indicative-prices/overview
- https://developers.skyscanner.net/docs/flights-indicative-prices/use-cases
- https://developers.skyscanner.net/docs/referrals/overview
- https://developers.skyscanner.net/docs/referrals/flights-parameters
- https://developers.skyscanner.net/docs/faqs

### Travelpayouts
- https://support.travelpayouts.com/hc/en-us/articles/360027634052-How-to-%D1%81reate-and-use-affiliate-links
- https://support.travelpayouts.com/hc/en-us/articles/360010109719-Kiwi-com-affiliate-links
- https://support.travelpayouts.com/hc/en-us/articles/5711895629714-Aviasales-affiliate-links
> NOTE: This research file still captures the earlier Amadeus-first analysis.
> The current implementation stack in code is Duffel Flights + Duffel Links.
> See `docs/STACK_OVERRIDE_DUFFEL.md` for the implementation override.
