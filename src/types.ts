export interface FareOption {
  fare_class: string;       // "Coach", "Business", "First Class", "Roomette", "Bedroom"
  fare_type: string;        // "Saver", "Value", "Flexible"
  price_cents: number | null; // null = sold out
  available: boolean;
}

export interface Train {
  number: string;
  name: string;
  departs_at: string;       // ISO datetime
  arrives_at: string;       // ISO datetime
  duration_minutes: number;
  fares: FareOption[];
  cheapest_cents: number | null; // min across available fares
}

export interface SearchParams {
  origin: string;           // station code e.g. "NYP"
  destination: string;
  travel_date: string;      // YYYY-MM-DD
  passengers?: number;      // default 1
}

export interface SearchResult {
  origin: string;
  destination: string;
  travel_date: string;
  scraped_at: string;
  trains: Train[];
}

export interface PriceSnapshot {
  id: number;
  origin: string;
  destination: string;
  travel_date: string;
  scraped_at: string;
  trains: Train[];
  min_price_cents: number | null;
}

export interface Route {
  id: number;
  origin: string;
  destination: string;
  created_at: string;
}

export interface Alert {
  id: number;
  route_id: number;
  travel_date: string | null;
  max_price_cents: number | null;
  notify_method: string;
  active: number;
  created_at: string;
}

// Alert joined with its route — what the scheduler actually works with
export interface AlertWithRoute extends Alert {
  origin: string;
  destination: string;
}
