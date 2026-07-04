/**
 * Scientific Validation — Evidence-layer tools (HTTP)
 *
 * All tools in this layer call external scholarly APIs.
 * They return structured EvidenceResult objects with a reproducibilityHash
 * based on the request parameters so identical queries produce identical hashes.
 *
 * Tools:
 *   arxiv_search            — arXiv search API
 *   pubmed_search           — PubMed E-utilities (NCBI)
 *   semanticscholar_search  — Semantic Scholar Graph API
 *   openalex_search         — OpenAlex works API
 *   crossref_resolve        — Crossref DOI metadata resolution
 *   europepmc_search        — Europe PMC RESTful search
 *
 * Risk level: external-side-effect (read-only API calls to external services)
 */

import { createHash } from 'node:crypto';
import { weaveTool } from '@weaveintel/core';
import type { Tool } from '@weaveintel/core';
import { httpRequest } from '@weaveintel/tools/http';

/** Structured evidence result returned by every evidence tool. */
export interface EvidenceResult {
  ok: boolean;
  sourceType: 'http_api';
  toolKey: string;
  query: string;
  reproducibilityHash: string;
  results: EvidenceItem[];
  totalHits?: number;
  error?: string;
}

export interface EvidenceItem {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  doi?: string;
  url?: string;
  abstract?: string;
  venue?: string;
  citationCount?: number;
}

function hashQuery(toolKey: string, params: Record<string, unknown>): string {
  return createHash('sha256')
    .update(toolKey)
    .update('\x00')
    .update(JSON.stringify(params, Object.keys(params).sort()))
    .digest('hex');
}

function errResult(toolKey: string, query: string, error: string): string {
  const r: EvidenceResult = {
    ok: false,
    sourceType: 'http_api',
    toolKey,
    query,
    reproducibilityHash: hashQuery(toolKey, { query }),
    results: [],
    error,
  };
  return JSON.stringify(r, null, 2);
}

// ─── arxiv_search ────────────────────────────────────────────────────────────

const arxivSearch = weaveTool({
  name: 'arxiv_search',
  description:
    'Search arXiv for preprints and papers. Returns structured evidence items with id, title, authors, year, DOI, abstract, and arXiv URL. Risk: external-side-effect.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (supports arXiv query syntax: "ti:transformer AND cat:cs.AI")',
      },
      max_results: {
        type: 'number',
        description: 'Maximum results to return (default: 5, max: 20)',
      },
      sort_by: {
        type: 'string',
        enum: ['relevance', 'lastUpdatedDate', 'submittedDate'],
        description: 'Sort order (default: relevance)',
      },
    },
    required: ['query'],
  },
  execute: async (args: { query: string; max_results?: number; sort_by?: string }) => {
    const maxResults = Math.min(20, Math.max(1, args.max_results ?? 5));
    const sortBy = args.sort_by ?? 'relevance';
    const params = {
      search_query: args.query,
      max_results: String(maxResults),
      sortBy,
    };
    const url = `https://export.arxiv.org/api/query?${new URLSearchParams(params).toString()}`;

    let resp;
    try {
      resp = await httpRequest({ url, method: 'GET', timeout: 15_000 });
    } catch (e) {
      return errResult('arxiv_search', args.query, `Network error: ${(e as Error).message}`);
    }

    if (resp.status !== 200) {
      return errResult('arxiv_search', args.query, `HTTP ${resp.status}`);
    }

    // Parse Atom XML
    const entries: EvidenceItem[] = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    while ((match = entryRegex.exec(resp.body)) !== null) {
      const entry = match[1] ?? '';
      const id = (/<id>([^<]+)<\/id>/.exec(entry)?.[1] ?? '').replace('http://arxiv.org/abs/', 'arxiv:');
      const title = /<title>([^<]+)<\/title>/.exec(entry)?.[1]?.trim() ?? '';
      const published = /<published>([^<]+)<\/published>/.exec(entry)?.[1] ?? '';
      const year = published ? new Date(published).getFullYear() : undefined;
      const abstract = /<summary>([^<]+)<\/summary>/.exec(entry)?.[1]?.trim();
      const authorMatches = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1] ?? '');
      const url = id.replace('arxiv:', 'https://arxiv.org/abs/');

      entries.push({ id, title, authors: authorMatches, year, url, abstract });
    }

    const result: EvidenceResult = {
      ok: true,
      sourceType: 'http_api',
      toolKey: 'arxiv_search',
      query: args.query,
      reproducibilityHash: hashQuery('arxiv_search', { query: args.query, maxResults, sortBy }),
      results: entries,
      totalHits: entries.length,
    };
    return JSON.stringify(result, null, 2);
  },
  tags: ['scientific', 'evidence', 'literature', 'external'],
  riskLevel: 'external-side-effect',
  requires: ['runtime.net.egress'],
});

// ─── pubmed_search ───────────────────────────────────────────────────────────

const pubmedSearch = weaveTool({
  name: 'pubmed_search',
  description:
    'Search PubMed via NCBI E-utilities. Returns structured evidence items with PMID, title, authors, year, DOI, abstract, and journal. Risk: external-side-effect.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'PubMed search query (supports MeSH terms and field tags)',
      },
      max_results: {
        type: 'number',
        description: 'Maximum results to return (default: 5, max: 20)',
      },
    },
    required: ['query'],
  },
  execute: async (args: { query: string; max_results?: number }, ctx) => {
    const maxResults = Math.min(20, Math.max(1, args.max_results ?? 5));
    // Phase C — resolve NCBI key via runtime.secrets when reachable, so
    // vault / per-tenant overrides compose. Env fallback preserves the
    // zero-config DX for tests + scripts.
    const apiKey = ctx?.runtime?.secrets
      ? (await ctx.runtime.secrets.resolve('NCBI_API_KEY').catch(() => undefined)) ?? process.env['NCBI_API_KEY']
      : process.env['NCBI_API_KEY'];
    const baseParams: Record<string, string> = {
      db: 'pubmed',
      term: args.query,
      retmax: String(maxResults),
      retmode: 'json',
      ...(apiKey ? { api_key: apiKey } : {}),
    };

    // Step 1: esearch to get PMIDs
    let searchResp;
    try {
      searchResp = await httpRequest({
        url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${new URLSearchParams(baseParams).toString()}`,
        method: 'GET',
        timeout: 15_000,
      });
    } catch (e) {
      return errResult('pubmed_search', args.query, `Network error: ${(e as Error).message}`);
    }

    if (searchResp.status !== 200) {
      return errResult('pubmed_search', args.query, `esearch HTTP ${searchResp.status}`);
    }

    let pmids: string[] = [];
    let totalHits = 0;
    try {
      const searchJson = JSON.parse(searchResp.body) as {
        esearchresult?: { idlist?: string[]; count?: string };
      };
      pmids = searchJson.esearchresult?.idlist ?? [];
      totalHits = Number(searchJson.esearchresult?.count ?? 0);
    } catch {
      return errResult('pubmed_search', args.query, 'Could not parse esearch response');
    }

    if (pmids.length === 0) {
      const result: EvidenceResult = {
        ok: true, sourceType: 'http_api', toolKey: 'pubmed_search', query: args.query,
        reproducibilityHash: hashQuery('pubmed_search', { query: args.query, maxResults }),
        results: [], totalHits: 0,
      };
      return JSON.stringify(result, null, 2);
    }

    // Step 2: efetch to get summaries
    const fetchParams: Record<string, string> = {
      db: 'pubmed', id: pmids.join(','), retmode: 'json',
      ...(apiKey ? { api_key: apiKey } : {}),
    };
    let fetchResp;
    try {
      fetchResp = await httpRequest({
        url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${new URLSearchParams(fetchParams).toString()}`,
        method: 'GET',
        timeout: 15_000,
      });
    } catch (e) {
      return errResult('pubmed_search', args.query, `Network error on efetch: ${(e as Error).message}`);
    }

    const items: EvidenceItem[] = [];
    try {
      const fetchJson = JSON.parse(fetchResp.body) as {
        result?: Record<string, {
          uid?: string; title?: string; authors?: Array<{ name?: string }>;
          pubdate?: string; elocationid?: string; fulljournalname?: string;
        }>;
      };
      const resultObj = fetchJson.result ?? {};
      for (const pmid of pmids) {
        const article = resultObj[pmid];
        if (!article) continue;
        const doi = article.elocationid?.startsWith('doi:')
          ? article.elocationid.slice(4)
          : undefined;
        items.push({
          id: `pmid:${pmid}`,
          title: article.title ?? '',
          authors: (article.authors ?? []).map((a) => a.name ?? ''),
          year: article.pubdate ? parseInt(article.pubdate) : undefined,
          doi,
          url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
          venue: article.fulljournalname,
        });
      }
    } catch {
      return errResult('pubmed_search', args.query, 'Could not parse efetch response');
    }

    const result: EvidenceResult = {
      ok: true, sourceType: 'http_api', toolKey: 'pubmed_search', query: args.query,
      reproducibilityHash: hashQuery('pubmed_search', { query: args.query, maxResults }),
      results: items, totalHits,
    };
    return JSON.stringify(result, null, 2);
  },
  tags: ['scientific', 'evidence', 'literature', 'external'],
  riskLevel: 'external-side-effect',
  requires: ['runtime.net.egress', 'runtime.secrets'],
});

// ─── semanticscholar_search ──────────────────────────────────────────────────

const semanticscholarSearch = weaveTool({
  name: 'semanticscholar_search',
  description:
    'Search the Semantic Scholar Graph API for academic papers. Returns title, authors, year, venue, citation count, DOI, and abstract. Risk: external-side-effect.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query for Semantic Scholar',
      },
      max_results: {
        type: 'number',
        description: 'Maximum results to return (default: 5, max: 20)',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional fields to fetch (e.g. ["citationCount", "abstract", "venue"])',
      },
    },
    required: ['query'],
  },
  execute: async (args: { query: string; max_results?: number; fields?: string[] }, ctx) => {
    const maxResults = Math.min(20, Math.max(1, args.max_results ?? 5));
    const apiKey = ctx?.runtime?.secrets
      ? (await ctx.runtime.secrets.resolve('SEMANTIC_SCHOLAR_API_KEY').catch(() => undefined)) ?? process.env['SEMANTIC_SCHOLAR_API_KEY']
      : process.env['SEMANTIC_SCHOLAR_API_KEY'];
    const defaultFields = ['paperId', 'title', 'authors', 'year', 'venue', 'citationCount',
      'externalIds', 'abstract'];
    const requestedFields = args.fields
      ? [...new Set([...defaultFields, ...args.fields])]
      : defaultFields;

    const params: Record<string, string> = {
      query: args.query,
      limit: String(maxResults),
      fields: requestedFields.join(','),
    };
    const headers: Record<string, string> = apiKey ? { 'x-api-key': apiKey } : {};

    let resp;
    try {
      resp = await httpRequest({
        url: `https://api.semanticscholar.org/graph/v1/paper/search?${new URLSearchParams(params).toString()}`,
        method: 'GET',
        headers,
        timeout: 15_000,
      });
    } catch (e) {
      return errResult('semanticscholar_search', args.query, `Network error: ${(e as Error).message}`);
    }

    if (resp.status !== 200) {
      return errResult('semanticscholar_search', args.query, `HTTP ${resp.status}`);
    }

    let items: EvidenceItem[] = [];
    let totalHits = 0;
    try {
      const data = JSON.parse(resp.body) as {
        total?: number;
        data?: Array<{
          paperId?: string;
          title?: string;
          authors?: Array<{ name?: string }>;
          year?: number;
          venue?: string;
          citationCount?: number;
          abstract?: string;
          externalIds?: { DOI?: string };
        }>;
      };
      totalHits = data.total ?? 0;
      items = (data.data ?? []).map((paper) => ({
        id: paper.paperId ?? '',
        title: paper.title ?? '',
        authors: (paper.authors ?? []).map((a) => a.name ?? ''),
        year: paper.year,
        venue: paper.venue,
        citationCount: paper.citationCount,
        doi: paper.externalIds?.DOI,
        abstract: paper.abstract,
        url: `https://www.semanticscholar.org/paper/${paper.paperId}`,
      }));
    } catch {
      return errResult('semanticscholar_search', args.query, 'Could not parse API response');
    }

    const result: EvidenceResult = {
      ok: true, sourceType: 'http_api', toolKey: 'semanticscholar_search', query: args.query,
      reproducibilityHash: hashQuery('semanticscholar_search', { query: args.query, maxResults }),
      results: items, totalHits,
    };
    return JSON.stringify(result, null, 2);
  },
  tags: ['scientific', 'evidence', 'literature', 'external'],
  riskLevel: 'external-side-effect',
  requires: ['runtime.net.egress', 'runtime.secrets'],
});

// ─── openalex_search ─────────────────────────────────────────────────────────

const openalexSearch = weaveTool({
  name: 'openalex_search',
  description:
    'Search OpenAlex works API for scholarly papers. Returns title, authors, year, venue, DOI, abstract, and citation count. Risk: external-side-effect.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Full-text search query for OpenAlex works',
      },
      max_results: {
        type: 'number',
        description: 'Maximum results to return (default: 5, max: 20)',
      },
      filter: {
        type: 'string',
        description: 'Optional OpenAlex filter expression (e.g. "publication_year:2020-2024")',
      },
    },
    required: ['query'],
  },
  execute: async (args: { query: string; max_results?: number; filter?: string }) => {
    const maxResults = Math.min(20, Math.max(1, args.max_results ?? 5));
    const params: Record<string, string> = {
      search: args.query,
      per_page: String(maxResults),
      select: 'id,title,authorships,publication_year,primary_location,cited_by_count,doi,abstract_inverted_index',
      mailto: process.env['OPENALEX_MAILTO'] ?? 'admin@weaveintel.ai',
    };
    if (args.filter) params['filter'] = args.filter;

    let resp;
    try {
      resp = await httpRequest({
        url: `https://api.openalex.org/works?${new URLSearchParams(params).toString()}`,
        method: 'GET',
        timeout: 15_000,
      });
    } catch (e) {
      return errResult('openalex_search', args.query, `Network error: ${(e as Error).message}`);
    }

    if (resp.status !== 200) {
      return errResult('openalex_search', args.query, `HTTP ${resp.status}`);
    }

    let items: EvidenceItem[] = [];
    let totalHits = 0;
    try {
      const data = JSON.parse(resp.body) as {
        meta?: { count?: number };
        results?: Array<{
          id?: string;
          title?: string;
          authorships?: Array<{ author?: { display_name?: string } }>;
          publication_year?: number;
          primary_location?: { source?: { display_name?: string } };
          cited_by_count?: number;
          doi?: string;
          abstract_inverted_index?: Record<string, number[]>;
        }>;
      };
      totalHits = data.meta?.count ?? 0;
      items = (data.results ?? []).map((work) => {
        // Reconstruct abstract from inverted index
        let abstract: string | undefined;
        if (work.abstract_inverted_index) {
          const wordPos: Array<[number, string]> = [];
          for (const [word, positions] of Object.entries(work.abstract_inverted_index)) {
            for (const pos of positions) wordPos.push([pos, word]);
          }
          abstract = wordPos.sort((a, b) => a[0] - b[0]).map((p) => p[1]).join(' ');
        }
        return {
          id: work.id ?? '',
          title: work.title ?? '',
          authors: (work.authorships ?? []).map((a) => a.author?.display_name ?? ''),
          year: work.publication_year,
          venue: work.primary_location?.source?.display_name,
          citationCount: work.cited_by_count,
          doi: work.doi?.replace('https://doi.org/', ''),
          url: work.id,
          abstract,
        };
      });
    } catch {
      return errResult('openalex_search', args.query, 'Could not parse API response');
    }

    const result: EvidenceResult = {
      ok: true, sourceType: 'http_api', toolKey: 'openalex_search', query: args.query,
      reproducibilityHash: hashQuery('openalex_search', { query: args.query, maxResults, filter: args.filter }),
      results: items, totalHits,
    };
    return JSON.stringify(result, null, 2);
  },
  tags: ['scientific', 'evidence', 'literature', 'external'],
  riskLevel: 'external-side-effect',
  requires: ['runtime.net.egress'],
});

// ─── crossref_resolve ─────────────────────────────────────────────────────────

const crossrefResolve = weaveTool({
  name: 'crossref_resolve',
  description:
    'Resolve a DOI via the Crossref REST API to retrieve structured metadata: title, authors, year, journal, volume, issue, pages, abstract, URL. Risk: external-side-effect.',
  parameters: {
    type: 'object',
    properties: {
      doi: {
        type: 'string',
        description: 'DOI to resolve (with or without https://doi.org/ prefix)',
      },
    },
    required: ['doi'],
  },
  execute: async (args: { doi: string }) => {
    const doi = args.doi.replace(/^https?:\/\/doi\.org\//i, '');
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    const headers: Record<string, string> = {
      'User-Agent': `WeaveintelSV/1.0 (mailto:${process.env['CROSSREF_MAILTO'] ?? 'admin@weaveintel.ai'})`,
    };

    let resp;
    try {
      resp = await httpRequest({ url, method: 'GET', headers, timeout: 15_000 });
    } catch (e) {
      return errResult('crossref_resolve', doi, `Network error: ${(e as Error).message}`);
    }

    if (resp.status === 404) {
      return errResult('crossref_resolve', doi, `DOI not found: ${doi}`);
    }
    if (resp.status !== 200) {
      return errResult('crossref_resolve', doi, `HTTP ${resp.status}`);
    }

    let item: EvidenceItem;
    try {
      const data = JSON.parse(resp.body) as {
        message?: {
          DOI?: string;
          title?: string[];
          author?: Array<{ given?: string; family?: string }>;
          issued?: { 'date-parts'?: number[][] };
          'container-title'?: string[];
          URL?: string;
          abstract?: string;
          'citation-count'?: number;
        };
      };
      const msg = data.message ?? {};
      const year = msg.issued?.['date-parts']?.[0]?.[0];
      item = {
        id: `doi:${doi}`,
        title: msg.title?.[0] ?? '',
        authors: (msg.author ?? []).map((a) =>
          [a.given, a.family].filter(Boolean).join(' ')),
        year,
        doi,
        url: msg.URL,
        venue: msg['container-title']?.[0],
        abstract: msg.abstract,
        citationCount: msg['citation-count'],
      };
    } catch {
      return errResult('crossref_resolve', doi, 'Could not parse Crossref response');
    }

    const result: EvidenceResult = {
      ok: true, sourceType: 'http_api', toolKey: 'crossref_resolve', query: doi,
      reproducibilityHash: hashQuery('crossref_resolve', { doi }),
      results: [item], totalHits: 1,
    };
    return JSON.stringify(result, null, 2);
  },
  tags: ['scientific', 'evidence', 'literature', 'external'],
  riskLevel: 'external-side-effect',
  requires: ['runtime.net.egress'],
});

// ─── europepmc_search ────────────────────────────────────────────────────────

const europepmcSearch = weaveTool({
  name: 'europepmc_search',
  description:
    'Search Europe PubMed Central for life-science literature. Returns structured evidence items with PMID/PMCID, title, authors, year, DOI, abstract, and journal. Risk: external-side-effect.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Europe PMC search query (supports field tags: TITLE:, AUTH:, JOURNAL:, etc.)',
      },
      max_results: {
        type: 'number',
        description: 'Maximum results to return (default: 5, max: 20)',
      },
    },
    required: ['query'],
  },
  execute: async (args: { query: string; max_results?: number }) => {
    const maxResults = Math.min(20, Math.max(1, args.max_results ?? 5));
    const params: Record<string, string> = {
      query: args.query,
      pageSize: String(maxResults),
      format: 'json',
      resultType: 'core',
    };

    let resp;
    try {
      resp = await httpRequest({
        url: `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${new URLSearchParams(params).toString()}`,
        method: 'GET',
        timeout: 15_000,
      });
    } catch (e) {
      return errResult('europepmc_search', args.query, `Network error: ${(e as Error).message}`);
    }

    if (resp.status !== 200) {
      return errResult('europepmc_search', args.query, `HTTP ${resp.status}`);
    }

    let items: EvidenceItem[] = [];
    let totalHits = 0;
    try {
      const data = JSON.parse(resp.body) as {
        hitCount?: number;
        resultList?: {
          result?: Array<{
            id?: string;
            title?: string;
            authorString?: string;
            pubYear?: string;
            doi?: string;
            journalTitle?: string;
            abstractText?: string;
          }>;
        };
      };
      totalHits = data.hitCount ?? 0;
      items = (data.resultList?.result ?? []).map((paper) => ({
        id: paper.id ? `europepmc:${paper.id}` : '',
        title: paper.title ?? '',
        authors: paper.authorString ? paper.authorString.split(', ') : [],
        year: paper.pubYear ? parseInt(paper.pubYear) : undefined,
        doi: paper.doi,
        venue: paper.journalTitle,
        abstract: paper.abstractText,
        url: paper.id
          ? `https://europepmc.org/article/MED/${paper.id}`
          : undefined,
      }));
    } catch {
      return errResult('europepmc_search', args.query, 'Could not parse API response');
    }

    const result: EvidenceResult = {
      ok: true, sourceType: 'http_api', toolKey: 'europepmc_search', query: args.query,
      reproducibilityHash: hashQuery('europepmc_search', { query: args.query, maxResults }),
      results: items, totalHits,
    };
    return JSON.stringify(result, null, 2);
  },
  tags: ['scientific', 'evidence', 'literature', 'external'],
  riskLevel: 'external-side-effect',
  requires: ['runtime.net.egress'],
});

// ─── Exports ────────────────────────────────────────────────────────────────

export function createEvidenceTools(): Record<string, Tool> {
  return {
    'arxiv_search': arxivSearch,
    'pubmed_search': pubmedSearch,
    'semanticscholar_search': semanticscholarSearch,
    'openalex_search': openalexSearch,
    'crossref_resolve': crossrefResolve,
    'europepmc_search': europepmcSearch,
  };
}
