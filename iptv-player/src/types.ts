export interface Channel {
  id: string;
  name: string;
  url: string;
  logo?: string;
  group?: string;
}

export interface ParseResult {
  channels: Channel[];
  errors: string[];
}
