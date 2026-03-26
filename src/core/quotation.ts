import { CanonicalOffer, Itinerary, SearchRequest, Segment } from "./types";

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const datePart = date.toISOString().slice(0, 10);
  const timePart = date.toISOString().slice(11, 16);
  return `${datePart} ${timePart}`;
}

function describePriceSource(offer: CanonicalOffer): string {
  if (offer.priceConfidence === "validated") {
    return "Reprice Agil";
  }

  return "Agil live";
}

function segmentLine(segment: Segment): string[] {
  return [
    `  Vuelo ${segment.flightNumber} · ${segment.marketingCarrier}`,
    `  Salida:   ${formatDateTime(segment.departureAt)}  ${segment.origin}${
      segment.originTerminal ? ` T${segment.originTerminal}` : ""
    }`,
    `  Llegada:  ${formatDateTime(segment.arrivalAt)}  ${segment.destination}${
      segment.destinationTerminal ? ` T${segment.destinationTerminal}` : ""
    }`,
    `  Duracion: ${segment.durationMinutes} min`,
  ];
}

export function buildQuotationText(
  offer: CanonicalOffer,
  request: SearchRequest,
): string {
  const lines: string[] = [];
  const mainPath = offer.purchasePaths[0];

  lines.push("COTIZACION DE VUELO");
  lines.push("========================================");
  lines.push("");
  lines.push(`RUTA:  ${offer.origin} -> ${offer.destination}`);
  lines.push(`TIPO:  ${offer.tripType}`);
  lines.push(`AEROLINEA: ${offer.mainCarrier ?? offer.validatingCarrier ?? "N/D"}`);
  lines.push("");

  for (const itinerary of offer.itineraries as Itinerary[]) {
    lines.push("----------------------------------------");
    lines.push(
      itinerary.direction === "inbound"
        ? "  VUELTA"
        : itinerary.direction === "outbound"
          ? "  IDA"
          : "  TRAMO",
    );
    lines.push("----------------------------------------");
    lines.push("");

    itinerary.segments.forEach((segment: Segment, index: number) => {
      lines.push(...segmentLine(segment));
      if (index < itinerary.segments.length - 1) {
        const next = itinerary.segments[index + 1];
        const connectionMinutes = Math.round(
          (new Date(next.departureAt).getTime() - new Date(segment.arrivalAt).getTime()) / 60000,
        );
        lines.push("");
        lines.push(`     Escala en ${segment.destination} · ${connectionMinutes} min`);
      }
      lines.push("");
    });
  }

  lines.push("PRECIO");
  lines.push("----------------------------------------");
  lines.push(
    `  TOTAL ..................... ${formatMoney(
      offer.price.total.amount,
      offer.price.total.currencyCode,
    )}`,
  );
  lines.push("");

  if (offer.fareMeta?.lastTicketingDate) {
    lines.push(`  Limite de emision ......... ${offer.fareMeta.lastTicketingDate}`);
  }
  if (typeof offer.fareMeta?.seatsRemaining === "number") {
    lines.push(`  Asientos visibles ......... ${offer.fareMeta.seatsRemaining}`);
  }
  if (offer.baggage?.description) {
    lines.push(`  Equipaje .................. ${offer.baggage.description}`);
  }

  lines.push("");
  lines.push("FUENTE DEL PRECIO");
  lines.push("----------------------------------------");
  lines.push(`  Fuente .................... ${describePriceSource(offer)}`);
  if (offer.priceVerifiedAt) {
    lines.push(`  Actualizado en ............ ${offer.priceVerifiedAt}`);
  }

  lines.push("");
  lines.push("SALIDA ACCIONABLE");
  lines.push("----------------------------------------");
  if (mainPath) {
    lines.push(`  Tipo ...................... ${mainPath.type}`);
    lines.push(`  Label ..................... ${mainPath.label}`);
    lines.push(`  Precision ................. ${mainPath.precision}`);
  } else {
    lines.push("  Tipo ...................... manual-reference");
  }

  lines.push("");
  lines.push("NOTAS");
  lines.push("----------------------------------------");
  lines.push("  - Precio sujeto a disponibilidad al emitir.");
  lines.push("  - Si el flujo termina en proveedor externo, el landing puede variar.");
  lines.push("  - Reprice recomendado antes de emitir.");
  lines.push("");
  lines.push(
    `PAX: ${request.passengers.adults} ADT / ${request.passengers.children} CHD / ${request.passengers.infants} INF`,
  );

  return lines.join("\n");
}
