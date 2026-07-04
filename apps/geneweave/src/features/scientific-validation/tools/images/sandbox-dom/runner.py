#!/usr/bin/env python3
"""
Domain science runner — reads JSON from stdin, dispatches to rdkit/biopython/networkx,
writes JSON result to stdout.

Supported operations:
  rdkit_descriptors   — Compute molecular descriptors from SMILES
  biopython_align     — Pairwise / multiple sequence alignment
  networkx_analyse    — Compute graph metrics (nodes, edges, degree, centrality, etc.)
"""
import sys
import json

def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"Invalid JSON input: {exc}"}))
        sys.exit(1)

    op = payload.get("op")
    try:
        if op == "rdkit_descriptors":
            from rdkit import Chem
            from rdkit.Chem import Descriptors, rdMolDescriptors
            smiles = payload["smiles"]
            mol = Chem.MolFromSmiles(smiles)
            if mol is None:
                print(json.dumps({"ok": False, "error": "Invalid SMILES string"}))
                sys.exit(1)

            requested = payload.get("descriptors", ["MolWt", "LogP", "NumHDonors", "NumHAcceptors",
                                                    "TPSA", "NumRotatableBonds", "NumRings"])
            desc_funcs = {name: func for name, func in Descriptors.descList}
            results = {}
            for name in requested:
                if name in desc_funcs:
                    results[name] = desc_funcs[name](mol)
                elif name == "InChI":
                    from rdkit.Chem.inchi import MolToInchi
                    results[name] = MolToInchi(mol)
                elif name == "InChIKey":
                    from rdkit.Chem.inchi import InchiToInchiKey, MolToInchi
                    inchi = MolToInchi(mol)
                    results[name] = InchiToInchiKey(inchi) if inchi else None

            print(json.dumps({"ok": True, "smiles": smiles,
                              "formula": rdMolDescriptors.CalcMolFormula(mol),
                              "descriptors": {k: (float(v) if isinstance(v, float) else v)
                                              for k, v in results.items()}}))

        elif op == "biopython_align":
            from Bio import pairwise2, Seq
            from Bio.pairwise2 import format_alignment
            seq_a = payload["seq_a"]
            seq_b = payload["seq_b"]
            mode = payload.get("mode", "globalxx")  # globalxx, localxx, globalms
            matrix = payload.get("matrix", "BLOSUM62")

            if mode == "globalxx":
                alignments = pairwise2.align.globalxx(seq_a, seq_b)
            elif mode == "localxx":
                alignments = pairwise2.align.localxx(seq_a, seq_b)
            elif mode == "globalms":
                match = payload.get("match", 2)
                mismatch = payload.get("mismatch", -1)
                open_gap = payload.get("open_gap", -0.5)
                extend_gap = payload.get("extend_gap", -0.1)
                alignments = pairwise2.align.globalms(seq_a, seq_b, match, mismatch, open_gap, extend_gap)
            else:
                print(json.dumps({"ok": False, "error": f"Unknown alignment mode: {mode}"}))
                sys.exit(1)

            if not alignments:
                print(json.dumps({"ok": True, "alignments": []}))
                return

            top = alignments[0]
            print(json.dumps({
                "ok": True,
                "score": top.score,
                "aligned_a": top.seqA,
                "aligned_b": top.seqB,
                "start": top.start,
                "end": top.end,
                "top_alignment_text": format_alignment(*top),
            }))

        elif op == "networkx_analyse":
            import networkx as nx
            import numpy as np

            nodes = payload.get("nodes", [])
            edges = payload.get("edges", [])
            directed = payload.get("directed", False)
            weighted = payload.get("weighted", False)

            G = nx.DiGraph() if directed else nx.Graph()
            G.add_nodes_from(nodes)
            for edge in edges:
                if weighted and len(edge) == 3:
                    G.add_edge(edge[0], edge[1], weight=edge[2])
                else:
                    G.add_edge(edge[0], edge[1])

            metrics: dict = {
                "num_nodes": G.number_of_nodes(),
                "num_edges": G.number_of_edges(),
                "density": nx.density(G),
                "is_connected": nx.is_weakly_connected(G) if directed else nx.is_connected(G),
            }

            if G.number_of_nodes() > 0:
                degree_centrality = nx.degree_centrality(G)
                metrics["avg_degree_centrality"] = float(np.mean(list(degree_centrality.values())))
                metrics["degree_centrality"] = {str(k): round(v, 6) for k, v in degree_centrality.items()}

                if not directed and nx.is_connected(G):
                    metrics["diameter"] = nx.diameter(G)
                    metrics["avg_shortest_path_length"] = nx.average_shortest_path_length(G)

                try:
                    betweenness = nx.betweenness_centrality(G)
                    metrics["betweenness_centrality"] = {str(k): round(v, 6)
                                                         for k, v in betweenness.items()}
                except Exception:
                    pass

                try:
                    clustering = nx.clustering(G) if not directed else {}
                    if clustering:
                        metrics["avg_clustering"] = float(np.mean(list(clustering.values())))
                except Exception:
                    pass

            print(json.dumps({"ok": True, "metrics": metrics}))

        else:
            print(json.dumps({"ok": False, "error": f"Unknown operation: {op}"}))
            sys.exit(1)

    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
