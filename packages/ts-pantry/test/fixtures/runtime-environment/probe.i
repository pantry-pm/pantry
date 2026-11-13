%module pantry_runtime_environment_probe
%inline %{
int answer(void) {
  return 42;
}
%}
