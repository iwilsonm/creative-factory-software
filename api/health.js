export default (req, res) => {
  res.status(200).json({ ok: true, service: 'creative-factory', ts: Date.now() });
};
