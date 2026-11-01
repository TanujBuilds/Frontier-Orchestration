"""Bounded saved-text selections. Source bytes are data, never executable authority."""
import copy
import hashlib
import re
from itertools import zip_longest

_FIELDS={'source_id','text_sha256','start','end'}

def make_passages(sources,windows,max_items=96):
    """Offer exact Python-character ranges in source prefixes and valid read windows."""
    if type(max_items) is not int or not 1<=max_items<=96:
        raise ValueError('passage catalog limit must be1..96')
    groups=[]
    for sid,source in list(sources.items())[:50]:
        text=source['text'];digest=hashlib.sha256(text.encode()).hexdigest()
        intervals=[(0,min(2000,len(text)))]
        for w in windows[:12]:
            if (w.get('source_id')==sid and w.get('text_sha256')==digest
                    and w.get('content_sha256')==source.get('contentSha256')
                    and type(w.get('start')) is int and type(w.get('end')) is int
                    and 0<=w['start']<w['end']<=len(text)):
                intervals.append((w['start'],w['end']))
        merged=[]
        for start,end in sorted(intervals):
            if merged and start<=merged[-1][1]:merged[-1]=(merged[-1][0],max(end,merged[-1][1]))
            else:merged.append((start,end))
        group=[]
        for start,end in merged:
            for offset in range(start,end,800):
                stop=min(offset+800,end)
                if stop-offset>=12:group.append({'source_id':sid,'text_sha256':digest,'start':offset,'end':stop,'text':text[offset:stop]})
        groups.append(group)
    offered=[]
    for layer in zip_longest(*groups):
        for entry in layer:
            if entry is not None:
                offered.append(entry)
                if len(offered)==max_items:return offered
    return offered


def resolve_report(report,sources,offered,strict=False):
    """Clone a report and resolve only exact selections present in its dispatched prompt.

    Legacy quotes are deliberately untouched unless strict=True. Strict mode accepts
    only raw closed selectors; canonical metadata is coordinator-owned. Invalid selector syntax, stale source
    identity, ambiguous offers or invented ranges fail before unchanged validation.
    Raw model reports and saved sources are never modified.
    """
    if not isinstance(offered,list) or len(offered)>96:raise ValueError('invalid offered passage catalog')
    result=copy.deepcopy(report)
    if not isinstance(result,dict) or not isinstance(result.get('claims'),list):return result
    if len(result['claims'])>100:raise ValueError('too many claims')
    for claim in result['claims']:
        if not isinstance(claim,dict):continue
        entries=claim.get('evidence',[])
        if not isinstance(entries,list):continue
        if len(entries)>10:raise ValueError('too many evidence entries')
        for i,entry in enumerate(entries):
            if strict and (not isinstance(entry,dict) or set(entry)!=_FIELDS):
                raise ValueError('selector-only output requires closed source_id,text_sha256,start,end evidence; legacy quotes and canonical metadata are forbidden')
            if not isinstance(entry,dict):continue
            nested='selection' in entry
            if nested:
                if set(entry)!={'source_id','quote','selection'} or not isinstance(entry['selection'],dict) or set(entry['selection'])!={'text_sha256','start','end'}:
                    raise ValueError('invalid model-supplied normalized selection')
                selected={'source_id':entry['source_id'],**entry['selection']}
            elif any(k in entry for k in ('start','end','text_sha256')):selected=entry
            else:continue
            if set(selected)!=_FIELDS:raise ValueError('passage selection requires only source_id,text_sha256,start,end')
            sid,digest,start,end=(selected[k] for k in ('source_id','text_sha256','start','end'))
            source=sources.get(sid) if isinstance(sid,str) else None
            if not source or not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):raise ValueError('unknown source or invalid passage hash')
            text=source['text']
            if hashlib.sha256(text.encode()).hexdigest()!=digest:raise ValueError('stale passage source hash')
            if type(start) is not int or type(end) is not int or not 0<=start<end<=len(text) or not 12<=end-start<=1000:raise ValueError('invalid passage range')
            matches=[row for row in offered if isinstance(row,dict) and all(type(row.get(k)) is type(selected[k]) and row.get(k)==selected[k] for k in _FIELDS)]
            quote=text[start:end]
            if len(matches)!=1 or matches[0].get('text')!=quote:raise ValueError('passage was not uniquely offered in the reserved prompt')
            if nested and entry['quote']!=quote:raise ValueError('normalized quote differs from its source selection')
            entries[i]={'source_id':sid,'quote':quote,'selection':{'text_sha256':digest,'start':start,'end':end}}
    return result
