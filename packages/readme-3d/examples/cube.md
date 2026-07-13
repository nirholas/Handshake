# The minimal example: a cube

Twelve triangles, hand-writable, renders as an interactive viewer on GitHub. This is the smallest possible "3D in markdown" - the whole block is under 2 KB.

```stl
solid cube
 facet normal 0.0 0.0 -1.0
  outer loop
   vertex -20.0 -20.0 0.0
   vertex -20.0 20.0 0.0
   vertex 20.0 20.0 0.0
  endloop
 endfacet
 facet normal 0.0 0.0 -1.0
  outer loop
   vertex -20.0 -20.0 0.0
   vertex 20.0 20.0 0.0
   vertex 20.0 -20.0 0.0
  endloop
 endfacet
 facet normal 0.0 0.0 1.0
  outer loop
   vertex -20.0 -20.0 40.0
   vertex 20.0 -20.0 40.0
   vertex 20.0 20.0 40.0
  endloop
 endfacet
 facet normal 0.0 0.0 1.0
  outer loop
   vertex -20.0 -20.0 40.0
   vertex 20.0 20.0 40.0
   vertex -20.0 20.0 40.0
  endloop
 endfacet
 facet normal 0.0 -1.0 0.0
  outer loop
   vertex -20.0 -20.0 0.0
   vertex 20.0 -20.0 0.0
   vertex 20.0 -20.0 40.0
  endloop
 endfacet
 facet normal 0.0 -1.0 0.0
  outer loop
   vertex -20.0 -20.0 0.0
   vertex 20.0 -20.0 40.0
   vertex -20.0 -20.0 40.0
  endloop
 endfacet
 facet normal 0.0 1.0 0.0
  outer loop
   vertex -20.0 20.0 0.0
   vertex -20.0 20.0 40.0
   vertex 20.0 20.0 40.0
  endloop
 endfacet
 facet normal 0.0 1.0 0.0
  outer loop
   vertex -20.0 20.0 0.0
   vertex 20.0 20.0 40.0
   vertex 20.0 20.0 0.0
  endloop
 endfacet
 facet normal -1.0 0.0 0.0
  outer loop
   vertex -20.0 -20.0 0.0
   vertex -20.0 -20.0 40.0
   vertex -20.0 20.0 40.0
  endloop
 endfacet
 facet normal -1.0 0.0 0.0
  outer loop
   vertex -20.0 -20.0 0.0
   vertex -20.0 20.0 40.0
   vertex -20.0 20.0 0.0
  endloop
 endfacet
 facet normal 1.0 0.0 0.0
  outer loop
   vertex 20.0 -20.0 0.0
   vertex 20.0 20.0 0.0
   vertex 20.0 20.0 40.0
  endloop
 endfacet
 facet normal 1.0 0.0 0.0
  outer loop
   vertex 20.0 -20.0 0.0
   vertex 20.0 20.0 40.0
   vertex 20.0 -20.0 40.0
  endloop
 endfacet
endsolid cube
```

Generated with:

```bash
npx readme-3d models/cube.stl --precision 1 --name cube
```
