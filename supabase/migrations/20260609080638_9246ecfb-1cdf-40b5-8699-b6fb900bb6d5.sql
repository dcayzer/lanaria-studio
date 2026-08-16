
CREATE POLICY "designs_insert" ON storage.objects FOR INSERT TO anon, authenticated WITH CHECK (bucket_id = 'designs');
CREATE POLICY "designs_select" ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'designs');
