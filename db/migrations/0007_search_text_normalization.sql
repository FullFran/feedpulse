-- Normalize search documents so keyword filtering is case and accent insensitive.

UPDATE entries
SET normalized_search_document = LOWER(
  TRANSLATE(
    COALESCE(title, '') || ' ' || COALESCE(content, ''),
    'áàäâãåéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
    'aaaaaaeeeeiiiiooooouuuuncaaaaaaeeeeiiiiooooouuuunc'
  )
)
WHERE normalized_search_document IS NULL
   OR normalized_search_document = ''
   OR normalized_search_document <> LOWER(
    TRANSLATE(
      COALESCE(title, '') || ' ' || COALESCE(content, ''),
      'áàäâãåéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
      'aaaaaaeeeeiiiiooooouuuuncaaaaaaeeeeiiiiooooouuuunc'
    )
  );
